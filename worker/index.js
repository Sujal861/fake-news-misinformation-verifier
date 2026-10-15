/**
 * Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /api/health  -> which evidence providers are configured
 *   POST /api/verify  -> { text } => full verification report
 *   GET  /api/samples -> demo forwards used by the UI
 *   *                 -> static assets from public/
 *
 * Runs entirely on fetch/Web APIs so it works under workerd as well as Node 20+.
 */

import { verify, providerStatus } from './lib/verify.js';
import { SAMPLES } from './lib/samples.js';
import { PRESETS, resolveLlmConfig } from './providers/llm.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const MAX_INPUT_CHARS = 20000;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

/** Best-effort per-isolate rate limit. Isolate-local by design; see README. */
const hits = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('api_error', { path: url.pathname, message });
        return json({ error: 'internal_error', message }, 500);
      }
    }

    if (env?.ASSETS?.fetch) {
      const response = await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    }

    return new Response('Not found', { status: 404 });
  },
};

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  switch (url.pathname) {
    case '/api/health':
      return handleHealth(env);
    case '/api/samples':
      return json({ samples: SAMPLES });
    case '/api/verify':
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handleVerify(request, env);
    default:
      return json({ error: 'not_found', path: url.pathname }, 404);
  }
}

function handleHealth(env) {
  const providers = providerStatus(env);
  const live = providers.filter((provider) => provider.configured).length;

  return json({
    status: 'ok',
    mode: live > 0 ? 'live-enhanced' : 'offline-heuristics',
    providers,
    capabilities: {
      offlineHeuristics: true,
      multilingualReasoning: providers.find((p) => p.id === 'llm')?.configured ?? false,
      factCheckDatabase: providers.find((p) => p.id === 'factcheck')?.configured ?? false,
      webEvidence: providers.find((p) => p.id === 'exa')?.configured ?? false,
    },
    limits: { maxInputChars: MAX_INPUT_CHARS, requestsPerMinute: RATE_LIMIT.max },
    // Offered so the UI can build a provider picker without hardcoding it.
    llmPresets: PRESETS.map(({ id, label, model, keyUrl }) => ({ id, label, model, keyUrl })),
  });
}

async function handleVerify(request, env) {
  const limited = rateLimited(request);
  if (limited) {
    return json({ error: 'rate_limited', message: `Too many requests. Try again in ${limited}s.` }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json', message: 'Request body must be JSON: {"text": "..."}' }, 400);
  }

  const text = typeof body?.text === 'string' ? body.text : '';
  if (text.trim().length === 0) {
    return json({ error: 'empty_text', message: 'Provide the forwarded message in the "text" field.' }, 400);
  }
  if (text.length > MAX_INPUT_CHARS) {
    return json(
      { error: 'text_too_long', message: `Message is ${text.length} characters; the limit is ${MAX_INPUT_CHARS}.` },
      413,
    );
  }

  // Optional bring-your-own-key: { llm: { provider, apiKey, model?, baseUrl? } }.
  // Validated before it reaches the pipeline; used for this request only.
  const llm = resolveLlmConfig(body?.llm);
  if (!llm.ok) {
    return json({ error: 'invalid_llm_config', message: llm.message }, 400);
  }

  const report = await verify(text, env, {
    useLive: body?.useLive !== false,
    llmConfig: llm.config,
  });
  return json(report);
}

function rateLimited(request) {
  const key = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    hits.set(key, { start: now, count: 1 });
    // Keep the map from growing without bound in long-lived isolates.
    if (hits.size > 5000) {
      for (const [existingKey, value] of hits) {
        if (now - value.start > RATE_LIMIT.windowMs) hits.delete(existingKey);
      }
    }
    return 0;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT.max) {
    return Math.ceil((entry.start + RATE_LIMIT.windowMs - now) / 1000);
  }
  return 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...JSON_HEADERS, ...corsHeaders() } });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
