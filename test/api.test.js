import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/index.js';
import { SAMPLES } from '../worker/lib/samples.js';
import { resolveLlmConfig } from '../worker/providers/llm.js';

const sample = (id) => SAMPLES.find((item) => item.id === id).text;

const OFFLINE_ENV = {};

const LIVE_ENV = {
  FACTCHECK_API_KEY: 'test-factcheck-key',
  EXA_API_KEY: 'test-exa-key',
  LLM_API_KEY: 'test-llm-key',
  LLM_BASE_URL: 'https://llm.example.com/v1',
  LLM_MODEL: 'test-model',
};

const ctx = { waitUntil() {}, passThroughOnException() {} };

function post(path, body, headers = {}) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path, headers = {}) {
  return new Request(`https://example.com${path}`, { headers });
}

async function call(request, env = OFFLINE_ENV) {
  const response = await worker.fetch(request, env, ctx);
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, payload, headers: response.headers };
}

/** Replace global fetch for the duration of a test, then restore it. */
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    calls.push({ url: href, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
    return stub(href, init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (data) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

// -------------------------------------------------------------------- health

test('GET /api/health reports offline capabilities when no keys are set', async () => {
  const { status, payload } = await call(get('/api/health'));
  assert.equal(status, 200);
  assert.equal(payload.mode, 'offline-heuristics');
  assert.equal(payload.capabilities.offlineHeuristics, true);
  assert.equal(payload.capabilities.multilingualReasoning, false);
  assert.equal(payload.providers.length, 3);
  assert.ok(payload.providers.every((provider) => provider.configured === false));
  assert.equal(payload.limits.maxInputChars, 20000);
});

test('GET /api/health flips to live-enhanced when keys exist', async () => {
  const { payload } = await call(get('/api/health'), LIVE_ENV);
  assert.equal(payload.mode, 'live-enhanced');
  assert.equal(payload.capabilities.multilingualReasoning, true);
  assert.equal(payload.capabilities.factCheckDatabase, true);
  assert.equal(payload.capabilities.webEvidence, true);
});

// ------------------------------------------------------------------- samples

test('GET /api/samples serves the bundled demo forwards', async () => {
  const { status, payload } = await call(get('/api/samples'));
  assert.equal(status, 200);
  assert.ok(Array.isArray(payload.samples));
  assert.ok(payload.samples.length >= 4);
  for (const item of payload.samples) {
    assert.ok(item.id && item.label && item.text);
  }
});

// -------------------------------------------------------------------- verify

test('POST /api/verify runs the offline pipeline and returns a full report', async () => {
  const { status, payload } = await call(post('/api/verify', { text: sample('whatsapp-charging') }));

  assert.equal(status, 200);
  assert.equal(payload.mode, 'offline-heuristics');
  assert.equal(payload.verdict.label, 'unverified');
  assert.equal(payload.verdict.riskBand, 'high');
  assert.ok(payload.verdict.riskScore >= 75);
  assert.ok(payload.redFlags.length > 0);
  assert.ok(payload.claims.length > 0);
  assert.ok(payload.recommendedActions.length > 0);
  assert.ok(payload.replySuggestion.length > 0);
  assert.equal(payload.factChecks.length, 0);
  assert.equal(payload.evidence.length, 0);
  assert.equal(payload.llm, null);
  assert.equal(payload.providers.factcheck.status, 'skipped');
  assert.match(payload.providers.factcheck.reason, /FACTCHECK_API_KEY/);
  assert.ok(payload.timings.total >= 0);
  assert.match(payload.id, /^fc_[0-9a-f]{8}$/);
});

test('POST /api/verify calls every configured provider and fuses the result', async () => {
  await withStubbedFetch(
    (href) => {
      if (href.includes('factchecktools.googleapis.com')) {
        return jsonResponse({
          claims: [
            {
              text: 'WhatsApp will charge Rs 500 per year',
              claimant: 'viral forward',
              claimReview: [
                {
                  textualRating: 'False',
                  url: 'https://www.boomlive.in/fact-check/whatsapp-charging',
                  publisher: { name: 'BOOM Fact Check' },
                  reviewDate: '2025-01-09',
                },
              ],
            },
          ],
        });
      }
      if (href.includes('api.exa.ai')) {
        return jsonResponse({
          results: [
            { title: 'WhatsApp is free to use', url: 'https://faq.whatsapp.com/general', highlights: ['WhatsApp is free and will remain free.'] },
          ],
        });
      }
      if (href.includes('llm.example.com')) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  language: 'en',
                  translation: '',
                  claims: ['WhatsApp will charge Rs 500 per year'],
                  verdict: 'likely-false',
                  confidence: 0.9,
                  reasoning: 'WhatsApp has repeatedly confirmed it does not charge subscription fees.',
                  redFlags: ['manufactured deadline'],
                  knownFactCheck: { matched: true, rating: 'false', note: 'Multiple fact-checkers have debunked this.' },
                  searchQueries: ['whatsapp subscription charge'],
                }),
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    },
    async (calls) => {
      const { status, payload } = await call(post('/api/verify', { text: sample('whatsapp-charging') }), LIVE_ENV);

      assert.equal(status, 200);
      assert.equal(payload.mode, 'live-enhanced');
      assert.equal(payload.verdict.label, 'likely-false');
      assert.ok(payload.verdict.confidence >= 0.7);
      assert.equal(payload.factChecks.length, 1);
      assert.equal(payload.factChecks[0].normalizedRating, 'false');
      assert.equal(payload.evidence.length, 1);
      assert.equal(payload.llm.model, 'test-model');
      assert.equal(payload.llm.knownFactCheck.rating, 'false');
      assert.equal(payload.providers.factcheck.status, 'ok');
      assert.equal(payload.providers.exa.status, 'ok');
      assert.equal(payload.providers.llm.status, 'ok');
      assert.ok(payload.replySuggestion.includes('boomlive.in'));

      // Every provider was actually exercised, and the LLM was asked last so it
      // could see the retrieved evidence.
      assert.ok(calls.some((entry) => entry.url.includes('factchecktools')));
      assert.ok(calls.some((entry) => entry.url.includes('api.exa.ai')));
      const llmCall = calls.findIndex((entry) => entry.url.includes('llm.example.com'));
      assert.ok(llmCall > 0, 'llm should be called after the lookups');
      assert.equal(calls[llmCall].method, 'POST');
    },
  );
});

test('one broken provider degrades the report instead of failing the request', async () => {
  await withStubbedFetch(
    (href) => {
      if (href.includes('factchecktools.googleapis.com')) {
        return new Response('quota exceeded', { status: 429 });
      }
      if (href.includes('api.exa.ai')) throw new Error('network down');
      if (href.includes('llm.example.com')) {
        return jsonResponse({
          choices: [{ message: { content: '{"verdict":"misleading","confidence":0.6,"reasoning":"Partial."}' } }],
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    },
    async () => {
      const { status, payload } = await call(post('/api/verify', { text: sample('miracle-cure') }), LIVE_ENV);

      assert.equal(status, 200);
      assert.equal(payload.providers.factcheck.status, 'error');
      assert.match(payload.providers.factcheck.reason, /429/);
      assert.equal(payload.providers.exa.status, 'error');
      assert.match(payload.providers.exa.reason, /network down/);
      assert.equal(payload.providers.llm.status, 'ok');
      assert.equal(payload.verdict.label, 'misleading');
      assert.ok(
        payload.verdict.evidenceSignals.some((signal) => signal.includes('model reasoning')),
        `expected the basis to name model reasoning, got ${JSON.stringify(payload.verdict.evidenceSignals)}`,
      );
      assert.equal(payload.verdict.scoring.factCheckMatches, 0);
      assert.equal(payload.verdict.scoring.webEvidence, 0);
    },
  );
});

test('useLive:false forces the offline path even with keys configured', async () => {
  const { payload } = await call(post('/api/verify', { text: sample('miracle-cure'), useLive: false }), LIVE_ENV);
  assert.equal(payload.mode, 'offline-heuristics');
  assert.equal(payload.providers.llm.status, 'skipped');
  assert.equal(payload.providers.llm.reason, 'live lookups disabled');
});

// ------------------------------------------------------- bring-your-own-key

test('GET /api/health offers LLM presets for the provider picker', async () => {
  const { payload } = await call(get('/api/health'));
  assert.ok(Array.isArray(payload.llmPresets));
  const ids = payload.llmPresets.map((preset) => preset.id);
  for (const expected of ['openai', 'groq', 'gemini', 'anthropic', 'mistral', 'deepseek', 'custom']) {
    assert.ok(ids.includes(expected), `expected preset ${expected} in ${ids.join(', ')}`);
  }
  for (const preset of payload.llmPresets) {
    assert.ok(preset.id && preset.label);
  }
});

test('a caller-supplied LLM key is used for reasoning with no server keys set', async () => {
  await withStubbedFetch(
    (href) => {
      if (href.includes('api.groq.com')) {
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify({
            language: 'en', translation: '', claims: ['WhatsApp will charge Rs 500 per year'],
            verdict: 'likely-false', confidence: 0.85,
            reasoning: 'WhatsApp is free; this claim circulates yearly.',
            redFlags: [], knownFactCheck: { matched: false, rating: 'none', note: '' }, searchQueries: [],
          }) } }],
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    },
    async (calls) => {
      // No env keys at all: the offline engine plus the caller's own key.
      const { status, payload } = await call(post('/api/verify', {
        text: sample('whatsapp-charging'),
        llm: { provider: 'groq', apiKey: 'gsk_test_key_12345' },
      }));

      assert.equal(status, 200);
      assert.equal(payload.mode, 'live-enhanced');
      assert.equal(payload.providers.llm.status, 'ok');
      assert.equal(payload.providers.llm.via, 'your-key');
      assert.equal(payload.providers.llm.model, 'llama-3.1-8b-instant');
      assert.equal(payload.verdict.label, 'likely-false');

      // Fact-check and web evidence stay skipped — the caller only brought an LLM key.
      assert.equal(payload.providers.factcheck.status, 'skipped');
      assert.equal(payload.providers.exa.status, 'skipped');

      const llmCall = calls.find((entry) => entry.url.includes('api.groq.com'));
      assert.ok(llmCall, 'expected a call to the preset base URL');
      assert.equal(llmCall.url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(llmCall.headers.authorization, 'Bearer gsk_test_key_12345');
      assert.equal(JSON.parse(llmCall.body).model, 'llama-3.1-8b-instant');

      // The key must never be echoed back in the report.
      assert.ok(!JSON.stringify(payload).includes('gsk_test_key_12345'), 'report leaked the API key');
    },
  );
});

test('a caller-supplied key overrides the server key and respects custom base URL/model', async () => {
  await withStubbedFetch(
    (href) => {
      if (href.includes('my-gateway.example.com')) {
        return jsonResponse({
          choices: [{ message: { content: '{"verdict":"misleading","confidence":0.6,"reasoning":"Framing issue."}' } }],
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    },
    async (calls) => {
      const { payload } = await call(post('/api/verify', {
        text: sample('miracle-cure'),
        llm: {
          provider: 'custom',
          apiKey: 'caller-key-123456',
          baseUrl: 'https://my-gateway.example.com/v1',
          model: 'my-favourite-model',
        },
      }), LIVE_ENV);

      assert.equal(payload.providers.llm.status, 'ok');
      assert.equal(payload.llm.model, 'my-favourite-model');
      assert.equal(payload.verdict.label, 'misleading');

      const llmCall = calls.find((entry) => entry.url.includes('my-gateway.example.com'));
      assert.ok(llmCall);
      assert.equal(llmCall.headers.authorization, 'Bearer caller-key-123456');
      // The server's own env keys must not have been used for the LLM call.
      assert.ok(!calls.some((entry) => entry.url.includes('llm.example.com')));
    },
  );
});

test('an invalid llm config is rejected with a helpful message', async () => {
  const bad = [
    { llm: { provider: 'openai', apiKey: 'short' } },
    { llm: { provider: 'custom', apiKey: 'valid-key-123456', baseUrl: 'ftp://nope.example.com' } },
    { llm: { provider: 'custom', apiKey: 'valid-key-123456', baseUrl: 'https://10.0.0.5/internal' } },
    { llm: { provider: 'custom', apiKey: 'valid-key-123456', baseUrl: 'https://api.example.com/v1' } },
    { llm: 'not-an-object' },
  ];
  for (const body of bad) {
    const { status, payload } = await call(post('/api/verify', { text: 'hello world', ...body }));
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(payload.error, 'invalid_llm_config');
    assert.ok(payload.message.length > 10);
  }
});

test('resolveLlmConfig validates shape, host and model', () => {
  assert.equal(resolveLlmConfig(undefined).config, null);
  assert.equal(resolveLlmConfig(null).config, null);

  const preset = resolveLlmConfig({ provider: 'gemini', apiKey: 'AIza-test-key-123' });
  assert.equal(preset.ok, true);
  assert.equal(preset.config.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(preset.config.model, 'gemini-2.5-flash-lite-preview-06-17');

  // localhost is allowed for dev machines running a local model server.
  const local = resolveLlmConfig({
    provider: 'custom', apiKey: 'ollama-key-12345', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2',
  });
  assert.equal(local.ok, true);

  // …but other private ranges are not.
  assert.equal(resolveLlmConfig({
    provider: 'custom', apiKey: 'key-12345678', baseUrl: 'http://192.168.1.9:11434/v1', model: 'm',
  }).ok, false);

  // Credentials embedded in the URL are refused.
  assert.equal(resolveLlmConfig({
    provider: 'custom', apiKey: 'key-12345678', baseUrl: 'https://user:pass@example.com/v1', model: 'm',
  }).ok, false);
});

test('an LLM endpoint that rejects response_format is retried without it', async () => {
  const attempts = [];
  await withStubbedFetch(
    (href, init) => {
      if (!href.includes('api.example.com')) throw new Error(`unexpected fetch to ${href}`);
      const payload = JSON.parse(init.body);
      attempts.push(payload);
      if (payload.response_format) {
        return new Response('Unsupported parameter: response_format', { status: 400 });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"verdict":"unverified","confidence":0.5,"reasoning":"No evidence."}' } }],
      });
    },
    async () => {
      const { payload } = await call(post('/api/verify', {
        text: sample('ambiguous-short'),
        llm: { provider: 'custom', apiKey: 'key-12345678', baseUrl: 'https://api.example.com/v1', model: 'm' },
      }));
      assert.equal(payload.providers.llm.status, 'ok');
      assert.equal(attempts.length, 2, 'expected exactly one retry without response_format');
      assert.ok(attempts[0].response_format, 'first attempt should carry response_format');
      assert.equal(attempts[1].response_format, undefined, 'retry must omit response_format');
    },
  );
});

// -------------------------------------------------------------- input handling

test('POST /api/verify rejects empty, malformed and oversized input', async () => {
  assert.equal((await call(post('/api/verify', { text: '   ' }))).payload.error, 'empty_text');
  assert.equal((await call(post('/api/verify', { text: 42 }))).payload.error, 'empty_text');
  assert.equal((await call(post('/api/verify', 'not json at all'))).payload.error, 'invalid_json');
  assert.equal((await call(post('/api/verify', { text: 'x'.repeat(20001) }))).status, 413);
  assert.equal((await call(post('/api/verify', { text: 'x'.repeat(20001) }))).payload.error, 'text_too_long');
});

test('unsupported methods and unknown API routes answer with the right status', async () => {
  const method = await call(get('/api/verify'));
  assert.equal(method.status, 405);
  assert.equal(method.payload.error, 'method_not_allowed');

  const missing = await call(get('/api/nope'));
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error, 'not_found');
});

test('OPTIONS preflight is answered with CORS headers', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/verify', { method: 'OPTIONS' }), OFFLINE_ENV, ctx);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('requests without a JSON content type still parse when the body is JSON', async () => {
  const request = new Request('https://example.com/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ text: sample('ambiguous-short') }),
  });
  const { status, payload } = await call(request);
  assert.equal(status, 200);
  assert.ok(payload.verdict);
});

// ------------------------------------------------------------------- assets

test('non-API routes fall through to the asset binding with security headers', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('<html>app</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    },
  };
  const response = await worker.fetch(get('/'), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await response.text(), '<html>app</html>');
});

test('non-API routes return 404 when no asset binding exists', async () => {
  const response = await worker.fetch(get('/'), {}, ctx);
  assert.equal(response.status, 404);
});

// --------------------------------------------------------------- rate limiting

test('the per-IP rate limit eventually answers 429', async () => {
  const headers = { 'cf-connecting-ip': '203.0.113.99' };
  let sawSuccess = false;
  let limited = null;

  for (let i = 0; i < 40; i += 1) {
    const { status, payload } = await call(post('/api/verify', { text: 'hello world' }, headers));
    if (status === 429) {
      limited = payload;
      break;
    }
    sawSuccess = true;
  }

  assert.equal(sawSuccess, true, 'expected some requests to succeed before the limit');
  assert.ok(limited, 'expected a 429 after burning the budget');
  assert.equal(limited.error, 'rate_limited');
  assert.match(limited.message, /Too many requests/);
});
