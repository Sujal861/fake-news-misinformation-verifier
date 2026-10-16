/**
 * Point Telegram at a deployed Worker.
 *
 * usage:  TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *           npm run set-webhook -- https://your-deployment.example
 *
 * The same values must be set as Worker secrets, because the Worker compares
 * the secret Telegram echoes back on every request against its own copy.
 */

import { setWebhook } from '../worker/channels/telegram.js';

const base = process.argv[2];
if (!base) {
  console.error('Usage: npm run set-webhook -- https://your-deployment.example');
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !secret) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment first.');
  console.error('Generate a secret with: node -e "console.log(crypto.randomUUID())"');
  process.exit(1);
}

const url = new URL('/telegram', base).toString();

const result = await setWebhook({
  env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret },
  url,
});

if (result?.ok) {
  console.log(`webhook registered -> ${url}`);
  console.log('Forward any message to the bot to check it.');
} else {
  console.error('Telegram refused the webhook:', result?.description ?? JSON.stringify(result));
  process.exitCode = 1;
}
