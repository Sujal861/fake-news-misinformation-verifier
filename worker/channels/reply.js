/**
 * The chat layer: one report, rendered as a plain-text message.
 *
 * WhatsApp and Telegram can only carry text, so this is where the report is
 * flattened into something readable in a chat bubble. Both channels share it so
 * the answer a person gets by forwarding a message to the bot is the same answer
 * they would get in the web app — just without the colour.
 *
 * The engine is the same `verify()` the API route uses, which means the bots
 * work with no provider keys configured at all: they fall back to the offline
 * heuristics, exactly like a static deployment of the page does.
 */

import { verify } from '../lib/verify.js';

/** Chat platforms cap a message; stay well inside the smallest limit (4096). */
const CHANNEL_TEXT_LIMIT = 2000;
const MAX_REPLY_CHARS = 3500;

/**
 * Check a message that arrived over a chat channel.
 *
 * Returns `{ ok: true, report, text }` or `{ ok: false, text }` — `text` is
 * always something safe to send straight back to the user.
 */
export async function answerMessage(rawText, env, options = {}) {
  const text = String(rawText ?? '').trim();

  if (text.length === 0) {
    return { ok: false, text: 'Forward me a message and I will check it for red flags, fact-checks and evidence.' };
  }
  if (text.length > CHANNEL_TEXT_LIMIT) {
    return {
      ok: false,
      text: `That message is ${text.length} characters. Chat forwards are usually much shorter — I check up to ${CHANNEL_TEXT_LIMIT}.`,
    };
  }

  const report = await verify(text, env, { timeoutMs: options.timeoutMs ?? 9000 });
  return { ok: true, report, text: verdictMessage(report) };
}

/**
 * Flatten a report into a chat message.
 *
 * Ordered by what a reader can act on: the verdict, the reasons, then the reply
 * they can send back. Deliberately plain text — no markdown — because the
 * platforms disagree about what they render.
 */
export function verdictMessage(report) {
  const { verdict } = report;
  const lines = [];

  lines.push(`ForwardCheck: ${verdict.title.toUpperCase()} — confidence ${Math.round(verdict.confidence * 100)}%`);
  lines.push(`Risk ${verdict.riskScore}/100 (${verdict.riskBand}). ${verdict.headline}`);
  lines.push('');

  if (report.redFlags.length > 0) {
    lines.push(`Red flags (${report.redFlags.length}):`);
    for (const flag of report.redFlags.slice(0, 5)) lines.push(`- ${flag.label}`);
    lines.push('');
  }

  if (report.factChecks.length > 0) {
    lines.push('Published fact-checks:');
    for (const check of report.factChecks.slice(0, 3)) {
      lines.push(`- ${check.publisher} rated this ${check.normalizedRating}${check.url ? `: ${check.url}` : ''}`);
    }
    lines.push('');
  }

  if (report.redFlags.length === 0 && report.factChecks.length === 0) {
    lines.push(verdict.basis);
    lines.push('');
  }

  if (report.recommendedActions.length > 0) {
    lines.push('What to do:');
    for (const action of report.recommendedActions.slice(0, 3)) lines.push(`- ${action}`);
    lines.push('');
  }

  lines.push('Reply you can send back:');
  lines.push(report.replySuggestion);

  const body = lines.join('\n').trim();
  return body.length > MAX_REPLY_CHARS ? `${body.slice(0, MAX_REPLY_CHARS - 1)}…` : body;
}
