/**
 * The offline verification pipeline — the part that needs no network, no
 * account and no API key.
 *
 * This module is deliberately free of Node APIs, provider imports and Worker
 * globals, because it is compiled twice: into the Worker bundle (where
 * lib/verify.js layers the live fact-check, web-evidence and LLM stages on top)
 * and into `public/engine.js` (where the browser runs it directly when no API
 * route answers). One implementation means the static deployment and the
 * Worker deployment cannot drift into giving different verdicts.
 *
 * Everything here is synchronous and pure apart from `offlineReport`, which
 * stamps a timestamp and an id.
 */

import { analyze, categoryLabel } from './heuristics.js';
import { extractClaims, claimQuery } from './claims.js';
import { fuse, replySuggestion, recommendedActions } from './verdict.js';
import { round2 } from './text.js';

/**
 * The evidence providers, described as data.
 *
 * Each provider module exports its own `label`, but this list is what the
 * browser bundle knows about, so it is the single source of truth for ids,
 * display labels and env var names. `configured` is decided by the Worker from
 * the real provider modules; in the browser every provider is simply skipped.
 */
export const PROVIDER_META = [
  { id: 'factcheck', label: 'Google Fact Check Tools', envVar: 'FACTCHECK_API_KEY' },
  { id: 'exa', label: 'Exa web search', envVar: 'EXA_API_KEY' },
  { id: 'llm', label: 'LLM reasoning', envVar: 'LLM_API_KEY' },
];

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
 * Stage 1: everything that can be computed from the message text alone.
 * Returns the heuristics result, the ranked claims and the lookup queries.
 *
 * @param {string} rawText
 */
export function offlineStage(rawText) {
  const heuristics = analyze(rawText);
  const claims = extractClaims(heuristics.ctx.text);
  const queries = buildQueries(claims, heuristics.ctx.text);
  return { heuristics, claims, queries };
}

/**
 * Assemble the report object the API and the UI both consume.
 *
 * Shared by the Worker's `verify()` and by the browser engine so the two
 * produce byte-comparable reports for the same input.
 *
 * @param {object} input
 * @param {string} input.rawText        The message as submitted.
 * @param {object} input.heuristics     Result of `offlineStage().heuristics`.
 * @param {Array}  input.claims         Result of `offlineStage().claims`.
 * @param {Array}  input.queries        Result of `offlineStage().queries`.
 * @param {Array}  [input.factChecks]
 * @param {Array}  [input.evidence]
 * @param {object} [input.llm]          Normalised LLM output, or null.
 * @param {object} [input.providers]    Provider id -> status object.
 * @param {object} [input.timings]
 * @param {number} [input.startedAt]    `Date.now()` at the start of the run.
 * @param {string} [input.servedBy]     'worker' | 'browser'.
 */
export function assembleReport({
  rawText,
  heuristics,
  claims,
  queries,
  factChecks = [],
  evidence = [],
  llm = null,
  providers = {},
  timings = {},
  startedAt = Date.now(),
  servedBy = 'worker',
}) {
  const tFuse = Date.now();
  const fused = fuse({ heuristics, factChecks, llm, evidence, claims });
  const fusionMs = Date.now() - tFuse;

  const report = {
    id: reportId(heuristics.ctx.text),
    createdAt: new Date().toISOString(),
    servedBy,
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
    llm,
    queries,
    providers,
    timings: { ...timings, fusion: fusionMs, total: Date.now() - startedAt },
    mode: Object.values(providers).some((provider) => provider.status === 'ok')
      ? 'live-enhanced'
      : 'offline-heuristics',
  };

  report.recommendedActions = recommendedActions({ ...report, heuristics });
  report.replySuggestion = replySuggestion(report);

  return report;
}

/**
 * The whole verification, offline: red-flag scan, claim extraction, scoring and
 * the suggested reply. No network, no keys.
 *
 * This is what the browser runs when the API route is missing or unreachable —
 * so a purely static host still gives a complete, honest report instead of an
 * error.
 *
 * @param {string} rawText
 * @param {{servedBy?: string}} [options]
 */
export function offlineReport(rawText, { servedBy = 'browser' } = {}) {
  const startedAt = Date.now();

  const tOffline = Date.now();
  const { heuristics, claims, queries } = offlineStage(rawText);
  const offlineMs = Date.now() - tOffline;

  const providers = {};
  for (const provider of PROVIDER_META) {
    providers[provider.id] = {
      status: 'skipped',
      label: provider.label,
      reason: `${provider.envVar} not set`,
    };
  }

  return assembleReport({
    rawText,
    heuristics,
    claims,
    queries,
    providers,
    timings: { offline: offlineMs },
    startedAt,
    servedBy,
  });
}

/**
 * A stable, non-cryptographic id for logging/dedup. We deliberately do not use
 * crypto here because the report content is not a secret and FNV-1a is enough
 * to distinguish two messages in a log line.
 */
export function reportId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fc_${hash.toString(16).padStart(8, '0')}`;
}

export { round2 };
