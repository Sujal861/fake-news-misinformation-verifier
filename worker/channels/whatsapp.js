/**
 * WhatsApp Cloud API channel.
 *
 * This is the channel the product is actually about: the forwards arrive on
 * WhatsApp, so the check should live there too — forward the message to the
 * business number and the verdict comes back in the same thread.
 *
 * Unlike Telegram this needs a Meta app: a WhatsApp Business account, a
 * registered number, an access token and an app secret. Nothing here runs until
 * those exist, which is why every guard below refuses rather than guesses.
 *
 * References:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
 */

import { answerMessage } from './reply.js';

export const id = 'whatsapp';
export const label = 'WhatsApp bot';
export const webhookPath = '/whatsapp';

const DEFAULT_VERSION = 'v26.0';

export function isConfigured(env) {
  return Boolean(
    env?.WHATSAPP_TOKEN
      && env?.WHATSAPP_PHONE_NUMBER_ID
      && env?.WHATSAPP_VERIFY_TOKEN
      && env?.WHATSAPP_APP_SECRET,
  );
}

/**
 * The GET half of the webhook: Meta calls it once when you save the callback URL
 * and expects `hub.challenge` echoed back as plain text.
 */
export function handleSubscription(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (!env?.WHATSAPP_VERIFY_TOKEN) return new Response('Not configured', { status: 503 });
  if (mode !== 'subscribe' || token !== env.WHATSAPP_VERIFY_TOKEN || !challenge) {
    return new Response('Forbidden', { status: 403 });
  }

  // Exactly the challenge value, as text: Meta compares it literally.
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

/**
 * Verify the `X-Hub-Signature-256` header: HMAC-SHA256 of the *raw* request body
 * keyed by the app secret.
 *
 * The body must be hashed as received — parsing it to JSON and re-serializing
 * would change the bytes and break the signature, so the caller passes bytes.
 */
export async function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;

  const supplied = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return timingSafeEqualHex(expected, supplied.toLowerCase());
}

/** Compare two hex digests without leaking where they first differ. */
export function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Pull the text messages out of a webhook payload.
 *
 * Status callbacks (sent / delivered / read) arrive on the same endpoint and
 * carry `statuses` instead of `messages`; they are ignored here.
 */
export function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const message of change?.value?.messages ?? []) {
        if (message?.type !== 'text') continue;
        const text = message?.text?.body;
        if (typeof text !== 'string' || message?.from === undefined) continue;
        out.push({ from: String(message.from), text, messageId: message?.id ?? '' });
      }
    }
  }
  return out;
}

export async function sendMessage(to, text, { env, fetchImpl = fetch } = {}) {
  const version = env?.WHATSAPP_API_VERSION || DEFAULT_VERSION;
  const endpoint = `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`WhatsApp send ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

export async function handleUpdate(payload, { env, fetchImpl = fetch } = {}) {
  const messages = extractMessages(payload);
  for (const message of messages) {
    const answer = await answerMessage(message.text, env);
    await sendMessage(message.from, answer.text, { env, fetchImpl });
  }
  return { handled: messages.length > 0, count: messages.length };
}

/**
 * The POST half of the webhook.
 *
 * Meta retries on non-2xx and can deliver the same event twice, so this
 * acknowledges quickly and does the work in the background.
 */
export async function handleWebhook(request, env, ctx, { fetchImpl = fetch } = {}) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!isConfigured(env)) return new Response('Not configured', { status: 503 });

  // Hashed as bytes, before any parsing: re-encoding JSON would change them.
  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256');
  if (!(await verifySignature(rawBody, signature, env.WHATSAPP_APP_SECRET))) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const work = handleUpdate(payload, { env, fetchImpl }).catch((error) => {
    console.error('whatsapp_update_failed', { message: error?.message ?? String(error) });
  });

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;

  return new Response('ok', { status: 200 });
}
