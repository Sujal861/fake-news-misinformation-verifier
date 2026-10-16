/**
 * Telegram bot channel.
 *
 * The whole point of this channel: someone gets a forward, and instead of
 * pasting it into a website they forward it to a bot and get the check back in
 * the same chat. Telegram is the cheap one to run — a bot token from @BotFather
 * is all it needs, no business verification.
 *
 * Reference: https://core.telegram.org/bots/api#setwebhook
 *            https://core.telegram.org/bots/api#sendmessage
 */

import { answerMessage } from './reply.js';

export const id = 'telegram';
export const label = 'Telegram bot';
export const webhookPath = '/telegram';

export function isConfigured(env) {
  return Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_WEBHOOK_SECRET);
}

const HELP = [
  'Forward me any message and I will check it — red flags, published fact-checks and a reply you can send back.',
  '',
  'I run the same engine as the web app:',
  '- The red-flag scan, claim ranking and scam detection work with no keys and no network.',
  '- If the server has fact-check or web-search keys, I add those sources too.',
  '',
  'Forward the whole thing, including "Forwarded many times" and any link.',
].join('\n');

/**
 * Register the webhook. Called by an operator (see README), never on a request:
 * it needs the deployed URL and rotates the secret.
 *
 * `secret_token` is echoed back on every webhook request in the
 * X-Telegram-Bot-Api-Secret-Token header, which is what lets us reject anything
 * that did not come from Telegram.
 */
export async function setWebhook({ env, url, fetchImpl = fetch }) {
  if (!env?.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const response = await fetchImpl(api(env, 'setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  });
  return response.json();
}

/**
 * Handle one update. Returns `{ handled: boolean }`; throws only on a transport
 * failure talking back to Telegram.
 */
export async function handleUpdate(update, { env, fetchImpl = fetch } = {}) {
  const message = update?.message;
  if (!message || typeof message.text !== 'string') return { handled: false };

  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return { handled: false };

  const text = message.text.trim();

  // /start is what Telegram sends when someone first opens the bot, so it must
  // not be analysed. Any other command gets the same help.
  if (text.startsWith('/')) {
    await sendMessage(chatId, HELP, { env, fetchImpl });
    return { handled: true, ok: true, kind: 'help' };
  }

  const answer = await answerMessage(text, env);
  await sendMessage(chatId, answer.text, { env, fetchImpl });
  return { handled: true, ok: answer.ok, kind: 'verdict' };
}

export async function sendMessage(chatId, text, { env, fetchImpl = fetch }) {
  if (!env?.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const response = await fetchImpl(api(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * The webhook itself.
 *
 * Telegram retries anything that is slow or answers non-2xx, so this returns 200
 * as soon as the request is authenticated and pushes the work into waitUntil.
 */
export async function handleWebhook(request, env, ctx, { fetchImpl = fetch } = {}) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!env?.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const update = await request.json().catch(() => null);
  if (!update) return new Response('Bad request', { status: 400 });

  const work = handleUpdate(update, { env, fetchImpl }).catch((error) => {
    console.error('telegram_update_failed', { message: error?.message ?? String(error) });
  });

  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;

  return new Response('ok', { status: 200 });
}

function api(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}
