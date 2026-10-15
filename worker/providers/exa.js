/**
 * Exa web evidence provider.
 *
 * Searches the live web and returns highlights from the most relevant pages so
 * the verdict can point at something citable. Used when a claim is not already
 * in a fact-check database (i.e. most of them).
 *
 * https://docs.exa.ai/reference/search
 */

const ENDPOINT = 'https://api.exa.ai/search';

export const id = 'exa';
export const label = 'Exa web search';

export function isConfigured(env) {
  return Boolean(env?.EXA_API_KEY);
}

/**
 * @param {string} query
 * @param {{env: object, numResults?: number, signal?: AbortSignal}} options
 */
export async function search(query, { env, numResults = 5, signal } = {}) {
  if (!isConfigured(env)) throw new Error('EXA_API_KEY is not configured');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults,
      contents: {
        highlights: { numSentences: 2, highlightsPerUrl: 2 },
      },
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(`Exa ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  return parseResponse(data);
}

export function parseResponse(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((result) => ({
    title: result.title ?? result.url ?? 'untitled',
    url: result.url ?? '',
    snippet: pickSnippet(result),
    publishedDate: result.publishedDate ?? '',
    author: result.author ?? '',
    provider: id,
  }));
}

function pickSnippet(result) {
  const highlights = Array.isArray(result.highlights) ? result.highlights.filter(Boolean) : [];
  if (highlights.length > 0) return highlights.join(' … ').replace(/\s+/g, ' ').trim();
  const text = typeof result.text === 'string' ? result.text : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 320);
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
