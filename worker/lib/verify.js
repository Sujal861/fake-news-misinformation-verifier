/**
 * The verification pipeline.
 *
 * Runs the offline engine first (cheap, always available), then fans out to the
 * configured evidence providers in parallel, then asks the LLM to reason over
 * whatever came back. A provider that is missing, slow or broken degrades the
 * report instead of failing the request: the verdict always comes back, with
 * `providers` describing exactly what contributed.
 */

import { analyze, categoryLabel } from './heuristics.js';
import { extractClaims, claimQuery } from './claims.js';
import { fuse, replySuggestion, recommendedActions } from './verdict.js';
import * as factcheck from '../providers/factcheck.js';
import * as exa from '../providers/exa.js';
import * as llm from '../providers/llm.js';
import { round2 } from './text.js';

export const PROVIDERS = [
  { id: factcheck.id, label: factcheck.label, envVar: 'FACTCHECK_API_KEY', isConfigured: factcheck.isConfigured },
  { id: exa.id, label: exa.label, envVar: 'EXA_API_KEY', isConfigured: exa.isConfigured },
  { id: llm.id, label: llm.label, envVar: 'LLM_API_KEY', isConfigured: llm.isConfigured },
];

const DEFAULT_TIMEOUT_MS = 12000;

/** Report which providers could contribute, for the /api/health endpoint. */
export function providerStatus(env) {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    envVar: provider.envVar,
    configured: provider.isConfigured(env),
  }));
}

/**
 * Build the search queries we will spend our lookup budget on. This is
 * deliberately deterministic rather than model-generated so that a report is
 * reproducible without an LLM.
 */
export function buildQueries(claims, text) {
  const queries = [];
  const seen = new Set();

  const push = (value) => {
    const query = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (query.length < 8) return;
    const key = query.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  for (const claim of claims.slice(0, 2)) push(claimQuery(claim.text, 120));

  // The offline extractor can be too aggressive with instructions, so fall back
  // to the opening of the message when it produced nothing usable.
  if (queries.length === 0) push(claimQuery(text, 120));

  return queries.slice(0, 2);
}

/**
 * @param {string} rawText
 * @param {object} env         Worker environment / provider keys.
 * @param {{timeoutMs?: number, useLive?: boolean, llmConfig?: object|null}} [options]
 *   `llmConfig` is a validated per-request bring-your-own-key setting (see
 *   providers/llm.js resolveLlmConfig). It overrides the server's env keys for
 *   the reasoning step only, and is never stored or echoed back.
 */
export async function verify(rawText, env = {}, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const useLive = options.useLive !== false;
  const llmConfig = options.llmConfig ?? null;
  const timings = {};

  const time = async (name, fn) => {
    const t0 = Date.now();
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  // ---------------------------------------------------------- offline stage
  const tOffline = Date.now();
  const heuristics = analyze(rawText);
  const claims = extractClaims(heuristics.ctx.text);
  const queries = buildQueries(claims, heuristics.ctx.text);
  timings.offline = Date.now() - tOffline;

  // The reasoning step runs on the server's key or the caller's own key.
  const llmReady = Boolean(llmConfig?.apiKey) || llm.isConfigured(env);

  const providers = {};
  for (const provider of PROVIDERS) {
    const configured = provider.id === 'llm' ? llmReady : provider.isConfigured(env);
    providers[provider.id] = configured && useLive
      ? { status: 'pending', label: provider.label }
      : { status: 'skipped', label: provider.label, reason: useLive ? `${provider.envVar} not set` : 'live lookups disabled' };
  }

  // ------------------------------------------------- fact-check + web evidence
  let factChecks = [];
  let evidence = [];

  const lookups = [];

  if (providers.factcheck.status === 'pending') {
    lookups.push(
      time('factcheck', () =>
        searchAcrossQueries(queries, (query, signal) =>
          factcheck.search(query, { env, languageCode: heuristics.ctx.language.code, signal }),
        ),
      ).then((result) => {
        if (result.ok) {
          factChecks = result.value;
          providers.factcheck = { status: factChecks.length > 0 ? 'ok' : 'ok', label: factcheck.label, matches: factChecks.length };
        } else {
          providers.factcheck = { status: 'error', label: factcheck.label, reason: result.error };
        }
      }),
    );
  }

  if (providers.exa.status === 'pending') {
    lookups.push(
      time('exa', () =>
        searchAcrossQueries(queries.slice(0, 1), (query, signal) =>
          exa.search(query, { env, signal, numResults: 5 }),
        ),
      ).then((result) => {
        if (result.ok) {
          evidence = result.value;
          providers.exa = { status: 'ok', label: exa.label, results: evidence.length };
        } else {
          providers.exa = { status: 'error', label: exa.label, reason: result.error };
        }
      }),
    );
  }

  if (lookups.length > 0) await Promise.allSettled(lookups);

  // ------------------------------------------------------------ reasoning stage
  let llmResult = null;

  if (providers.llm.status === 'pending') {
    const result = await time('llm', () =>
      llm.analyze(
        {
          text: heuristics.ctx.text,
          claims,
          factChecks,
          evidence,
          detectedLanguage: heuristics.ctx.language.code,
        },
        { env, config: llmConfig ?? undefined, signal: timeoutSignal(timeoutMs) },
      ),
    );
    if (result.ok) {
      llmResult = { ...result.value, evidenceUsed: evidence.length > 0 || factChecks.length > 0 };
      providers.llm = {
        status: 'ok',
        label: llm.label,
        model: llmResult.model,
        ...(llmConfig ? { via: 'your-key' } : {}),
      };
    } else {
      providers.llm = { status: 'error', label: llm.label, reason: result.error };
    }
  }

  // ------------------------------------------------------------------- fusion
  const tFuse = Date.now();
  const fused = fuse({ heuristics, factChecks, llm: llmResult, evidence, claims });
  timings.fusion = Date.now() - tFuse;

  const report = {
    id: reportId(heuristics.ctx.text),
    createdAt: new Date().toISOString(),
    input: {
      text: heuristics.ctx.text,
      length: heuristics.ctx.text.length,
      truncated: rawText.length > heuristics.ctx.text.length,
    },
    language: heuristics.ctx.language,
    verdict: fused,
    claims: claims.map((claim) => ({ text: claim.text, checkWorthiness: claim.checkWorthiness })),
    redFlags: heuristics.matched.map((hit) => ({ ...hit, categoryLabel: categoryLabel(hit.category) })),
    credibilityCredits: heuristics.credits.map((hit) => ({ ...hit, categoryLabel: categoryLabel(hit.category) })),
    factChecks,
    evidence,
    llm: llmResult,
    queries,
    providers,
    timings: { ...timings, total: Date.now() - startedAt },
    mode: providers.llm.status === 'ok' || providers.exa.status === 'ok' || providers.factcheck.status === 'ok'
      ? 'live-enhanced'
      : 'offline-heuristics',
  };

  report.recommendedActions = recommendedActions({ ...report, heuristics });
  report.replySuggestion = replySuggestion(report);

  return report;
}

/** Run the same lookup across several queries, de-duplicating the union. */
async function searchAcrossQueries(queries, run) {
  const signal = timeoutSignal(DEFAULT_TIMEOUT_MS);
  const results = await Promise.allSettled(queries.map((query) => run(query, signal)));

  const merged = [];
  const seen = new Set();
  let firstError = null;

  for (const result of results) {
    if (result.status === 'rejected') {
      firstError ??= result.reason instanceof Error ? result.reason.message : String(result.reason);
      continue;
    }
    for (const item of result.value ?? []) {
      const key = item.url || item.claim || JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  if (merged.length === 0 && firstError) throw new Error(firstError);
  return merged;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * A stable, non-cryptographic id for logging/dedup. We deliberately do not use
 * crypto here because the report content is not a secret and FNV-1a is enough
 * to distinguish two messages in a log line.
 */
function reportId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fc_${hash.toString(16).padStart(8, '0')}`;
}

export { round2 };
