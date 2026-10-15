/**
 * Google Fact Check Tools API provider.
 *
 * This is a real fact-check database lookup: it searches ClaimReview markup
 * published by fact-checking organisations (AFP Fact Check, BOOM, AltNews,
 * PolitiFact, Snopes, ...). It is free but requires a Google Cloud API key.
 *
 * https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search
 */

import { normalizeRating } from '../lib/verdict.js';

const ENDPOINT = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

export const id = 'factcheck';
export const label = 'Google Fact Check Tools';

export function isConfigured(env) {
  return Boolean(env?.FACTCHECK_API_KEY);
}

/**
 * @param {string} query
 * @param {{env: object, languageCode?: string, pageSize?: number, signal?: AbortSignal}} options
 */
export async function search(query, { env, languageCode, pageSize = 5, signal } = {}) {
  if (!isConfigured(env)) throw new Error('FACTCHECK_API_KEY is not configured');

  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('key', env.FACTCHECK_API_KEY);
  // The API accepts a BCP-47 code; our detector can hand back a script-tagged
  // variant like `hi-Latn` which it would reject.
  const clean = normalizeLanguageCode(languageCode);
  if (clean) url.searchParams.set('languageCode', clean);

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(`Fact Check API ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  return parseResponse(data);
}

export function parseResponse(data) {
  const claims = Array.isArray(data?.claims) ? data.claims : [];
  const out = [];

  for (const entry of claims) {
    for (const review of entry.claimReview ?? []) {
      const textualRating = review.textualRating ?? '';
      out.push({
        claim: entry.text ?? '',
        claimant: entry.claimant ?? '',
        publisher: review.publisher?.name ?? review.publisher?.site ?? 'unknown publisher',
        rating: textualRating,
        normalizedRating: normalizeRating(textualRating),
        url: review.url ?? '',
        reviewDate: review.reviewDate ?? '',
        languageCode: entry.languageCode ?? review.languageCode ?? '',
        provider: id,
      });
    }
  }

  // Best-rated first: a plain "false" outranks "mixture".
  const priority = { false: 0, misleading: 1, satire: 2, true: 3, unknown: 4 };
  out.sort((a, b) => (priority[a.normalizedRating] ?? 9) - (priority[b.normalizedRating] ?? 9));
  return out.slice(0, 8);
}

function normalizeLanguageCode(code) {
  if (!code || code === 'und') return undefined;
  const base = String(code).split('-')[0];
  return /^[a-z]{2}$/.test(base) ? base : undefined;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
