import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import * as telegram from '../worker/channels/telegram.js';
import * as whatsapp from '../worker/channels/whatsapp.js';
import { verdictMessage, answerMessage } from '../worker/channels/reply.js';
import { offlineReport } from '../worker/lib/offline.js';

/** The message from the reported bug: a scam the offline engine used to miss. */
const SCAM =
  'give me 10000rsd I will retun imlinando;ljasf and share this message to 100 people I will giv epou 30000';

/**
 * Stands in for the platform API. Every channel takes its fetch as a parameter,
 * which is what keeps these tests offline and deterministic.
 */
function recorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {},
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

/** A ctx that records background work so the test can await it. */
function deferredContext() {
  const pending = [];
  return { pending, ctx: { waitUntil: (promise) => pending.push(promise) } };
}

const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_WEBHOOK_SECRET: 'hook-secret' };

// --------------------------------------------------------------------- reply

test('a report is flattened into a chat message', () => {
  const text = verdictMessage(offlineReport(SCAM));
  assert.match(text, /^ForwardCheck: UNVERIFIED/);
  assert.match(text, /Risk 62\/100 \(elevated\)/);
  assert.match(text, /Red flags \(\d+\):/);
  assert.match(text, /Red flags[\s\S]*- Threat or pressure to re-forward/);
  assert.match(text, /- Promises to send back more than you send/);
  assert.match(text, /Reply you can send back:/);
  assert.ok(text.length < 4096, `chat message was ${text.length} chars`);
});

test('an empty or oversized chat message is refused, not analysed', async () => {
  const empty = await answerMessage('   ', {});
  assert.equal(empty.ok, false);
  assert.match(empty.text, /Forward me a message/);

  const oversized = await answerMessage('x'.repeat(3000), {});
  assert.equal(oversized.ok, false);
  assert.match(oversized.text, /characters/);
});

// ------------------------------------------------------------------ telegram

test('telegram replies to a forwarded message with the verdict', async () => {
  const { calls, fetchImpl } = recorder();
  const result = await telegram.handleUpdate(
    { update_id: 1, message: { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: SCAM } },
    { env: TELEGRAM_ENV, fetchImpl },
  );

  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, 42);
  assert.match(calls[0].body.text, /ForwardCheck: UNVERIFIED/);
  assert.equal(calls[0].body.disable_web_page_preview, true);
});

test('telegram answers /start with help rather than analysing the command', async () => {
  const { calls, fetchImpl } = recorder();
  const result = await telegram.handleUpdate(
    { message: { chat: { id: 1 }, text: '/start' } },
    { env: TELEGRAM_ENV, fetchImpl },
  );

  assert.equal(result.kind, 'help');
  assert.match(calls[0].body.text, /Forward me any message/);
  assert.doesNotMatch(calls[0].body.text, /ForwardCheck: /);
});

test('telegram ignores updates that are not new text messages', async () => {
  const { calls, fetchImpl } = recorder();
  const updates = [
    {},
    { edited_message: { chat: { id: 1 }, text: SCAM } },
    { message: { chat: { id: 1 }, photo: [{ file_id: 'x' }] } },
    { message: { text: SCAM } },
    { callback_query: { data: 'x' } },
  ];

  for (const update of updates) {
    const result = await telegram.handleUpdate(update, { env: TELEGRAM_ENV, fetchImpl });
    assert.equal(result.handled, false);
  }
  assert.equal(calls.length, 0);
});

test('the telegram webhook refuses a request without the secret token', async () => {
  const request = new Request('https://example.com/telegram', { method: 'POST', body: '{}' });
  const response = await telegram.handleWebhook(request, TELEGRAM_ENV);
  assert.equal(response.status, 401);
});

test('the telegram webhook answers 200 and sends the verdict for a valid token', async () => {
  const { calls, fetchImpl } = recorder();
  const { pending, ctx } = deferredContext();

  const request = new Request('https://example.com/telegram', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_ENV.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ message: { chat: { id: 99 }, text: SCAM } }),
  });

  const response = await telegram.handleWebhook(request, TELEGRAM_ENV, ctx, { fetchImpl });
  assert.equal(response.status, 200);
  await Promise.all(pending);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, 99);
});

test('the telegram webhook rejects a GET', async () => {
  const request = new Request('https://example.com/telegram', { method: 'GET' });
  const response = await telegram.handleWebhook(request, TELEGRAM_ENV);
  assert.equal(response.status, 405);
});

// ------------------------------------------------------------------ whatsapp

const WHATSAPP_ENV = {
  WHATSAPP_TOKEN: 'access-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_APP_SECRET: 'app-secret',
};

/** The exact body Meta would sign. */
function signedRequest(payload, { secret = WHATSAPP_ENV.WHATSAPP_APP_SECRET, signature } = {}) {
  const body = JSON.stringify(payload);
  const digest = signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return new Request('https://example.com/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': digest },
    body,
  });
}

const inboundPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: WHATSAPP_ENV.WHATSAPP_PHONE_NUMBER_ID },
            contacts: [{ profile: { name: 'Test' }, wa_id: '919876543210' }],
            messages: [
              { from: '919876543210', id: 'wamid.TEST', timestamp: '1700000000', type: 'text', text: { body: SCAM } },
            ],
          },
        },
      ],
    },
  ],
};

test('the whatsapp subscription handshake echoes the challenge', async () => {
  const url = 'https://example.com/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=abc123';
  const response = await whatsapp.handleSubscription(new Request(url), WHATSAPP_ENV);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'abc123');
});

test('the whatsapp subscription handshake rejects the wrong token or mode', async () => {
  const wrongToken = 'https://example.com/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc';
  assert.equal((await whatsapp.handleSubscription(new Request(wrongToken), WHATSAPP_ENV)).status, 403);

  const wrongMode = 'https://example.com/whatsapp?hub.mode=unsubscribe&hub.verify_token=verify-token&hub.challenge=abc';
  assert.equal((await whatsapp.handleSubscription(new Request(wrongMode), WHATSAPP_ENV)).status, 403);

  const unconfigured = 'https://example.com/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc';
  assert.equal((await whatsapp.handleSubscription(new Request(unconfigured), {})).status, 503);
});

test('whatsapp verifies the HMAC signature and rejects a forgery', async () => {
  const body = new TextEncoder().encode(JSON.stringify(inboundPayload)).buffer;
  const good = createHmac('sha256', WHATSAPP_ENV.WHATSAPP_APP_SECRET).update(Buffer.from(body)).digest('hex');

  assert.equal(await whatsapp.verifySignature(body, `sha256=${good}`, WHATSAPP_ENV.WHATSAPP_APP_SECRET), true);
  assert.equal(
    await whatsapp.verifySignature(body, `sha256=${createHmac('sha256', 'wrong').update(Buffer.from(body)).digest('hex')}`, WHATSAPP_ENV.WHATSAPP_APP_SECRET),
    false,
  );
  assert.equal(await whatsapp.verifySignature(body, undefined, WHATSAPP_ENV.WHATSAPP_APP_SECRET), false);
  assert.equal(await whatsapp.verifySignature(body, 'sha256=nothex', WHATSAPP_ENV.WHATSAPP_APP_SECRET), false);
  assert.equal(await whatsapp.verifySignature(body, `sha256=${good}`, ''), false);
});

test('whatsapp ignores status callbacks', () => {
  const statusPayload = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered', recipient_id: '91' }] } }] }],
  };
  assert.deepEqual(whatsapp.extractMessages(statusPayload), []);
  assert.deepEqual(whatsapp.extractMessages({}), []);

  const extracted = whatsapp.extractMessages(inboundPayload);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].from, '919876543210');
  assert.equal(extracted[0].text, SCAM);
});

test('a signed whatsapp message gets a verdict sent back', async () => {
  const { calls, fetchImpl } = recorder();
  const { pending, ctx } = deferredContext();

  const response = await whatsapp.handleWebhook(signedRequest(inboundPayload), WHATSAPP_ENV, ctx, { fetchImpl });
  assert.equal(response.status, 200);
  await Promise.all(pending);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /graph\.facebook\.com\/v26\.0\/1234567890\/messages$/);
  assert.equal(calls[0].headers.authorization, 'Bearer access-token');
  assert.equal(calls[0].body.messaging_product, 'whatsapp');
  assert.equal(calls[0].body.to, '919876543210');
  assert.match(calls[0].body.text.body, /ForwardCheck: UNVERIFIED/);
});

test('a whatsapp message with a bad signature is rejected before parsing', async () => {
  const { calls, fetchImpl } = recorder();
  const forged = signedRequest(inboundPayload, { secret: 'attacker-secret' });
  const response = await whatsapp.handleWebhook(forged, WHATSAPP_ENV, {}, { fetchImpl });

  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('the whatsapp webhook refuses to run unconfigured', async () => {
  const response = await whatsapp.handleWebhook(signedRequest(inboundPayload), {}, {});
  assert.equal(response.status, 503);
});

test('the whatsapp API version can be overridden', async () => {
  const { calls, fetchImpl } = recorder();
  await whatsapp.sendMessage('919876543210', 'hi', { env: { ...WHATSAPP_ENV, WHATSAPP_API_VERSION: 'v21.0' }, fetchImpl });
  assert.match(calls[0].url, /\/v21\.0\//);
});
