/**
 * The verification pipeline.
 *
 * Runs the offline engine first (cheap, always available), then fans out to the
 * configured evidence providers in parallel, then asks the LLM to reason over
 * whatever came back. A provider that is missing, slow or broken degrades the
 * report instead of failing the request: the verdict always comes back, with
 * `providers` describing exactly what contributed.
 */

import { PROVIDER_META, buildQueries, offlineStage, assembleReport } from './offline.js';
import * as factcheck from '../providers/factcheck.js';
import * as exa from '../providers/exa.js';
import * as llm from '../providers/llm.js';
import { round2 } from './text.js';

// Labels and env var names live in offline.js so the browser bundle knows them
// too; here we only bind them to the provider modules that can actually answer.
const PROVIDER_MODULES = { factcheck, exa, llm };

export const PROVIDERS = PROVIDER_META.map((meta) => ({
  id: PROVIDER_MODULES[meta.id].id,
  label: PROVIDER_MODULES[meta.id].label,
  envVar: meta.envVar,
  isConfigured: PROVIDER_MODULES[meta.id].isConfigured,
}));

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

export { buildQueries };

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
  const { heuristics, claims, queries } = offlineStage(rawText);
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

  // --------------------------------------------------------- fusion + report
  return assembleReport({
    rawText,
    heuristics,
    claims,
    queries,
    factChecks,
    evidence,
    llm: llmResult,
    providers,
    timings,
    startedAt,
    servedBy: 'worker',
  });
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

export { round2 };
