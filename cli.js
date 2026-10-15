#!/usr/bin/env node
/**
 * ForwardCheck CLI — the same pipeline as the web app, runnable locally.
 *
 *   node cli.js "WhatsApp is going to charge Rs 500 per year..."
 *   pbpaste | node cli.js --json
 *   node cli.js --sample whatsapp-charging --no-live
 *
 * Keys are read from the environment or from `.dev.vars` (see .dev.vars.example).
 * With no keys it runs the offline heuristic engine, which needs no network.
 */

import { readFile } from 'node:fs/promises';
import { verify } from './worker/lib/verify.js';
import { SAMPLES } from './worker/lib/samples.js';

const COLORS = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  blue: '\u001b[34m',
  gray: '\u001b[90m',
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positional = args.filter((arg) => !arg.startsWith('--'));

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const env = await loadEnv();
  const text = await resolveText();

  if (text.trim() === '') {
    console.error('Nothing to check. Pass a message as an argument, pipe it on stdin, or use --sample <id>.');
    console.error(`Available samples: ${SAMPLES.map((sample) => sample.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const report = await verify(text, env, { useLive: !flags.has('--no-live') });

  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report, { color: process.stdout.isTTY && !flags.has('--no-color') });
}

async function resolveText() {
  const sampleId = valueOf('--sample');
  if (sampleId) {
    const sample = SAMPLES.find((item) => item.id === sampleId);
    if (!sample) throw new Error(`Unknown sample "${sampleId}". Available: ${SAMPLES.map((s) => s.id).join(', ')}`);
    return sample.text;
  }
  if (positional.length > 0) return positional.join(' ');
  if (process.stdin.isTTY) return '';

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : null;
}

/** Parse `.dev.vars` (wrangler's local secrets file) the same way wrangler does. */
async function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = await readFile(new URL('./.dev.vars', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
      if (value !== '' && !env[key]) env[key] = value;
    }
  } catch {
    /* no .dev.vars: offline mode */
  }
  return env;
}

function printReport(report, { color }) {
  const c = (name, value) => (color ? `${COLORS[name]}${value}${COLORS.reset}` : value);
  const toneColor = { danger: 'red', warn: 'yellow', ok: 'green', neutral: 'blue' }[report.verdict.tone] ?? 'blue';

  const line = '─'.repeat(64);
  console.log('');
  console.log(c('dim', line));
  console.log(`${c('bold', report.verdict.label.toUpperCase().replace('-', ' '))}  ${c('dim', `· risk ${report.verdict.riskScore}/100 (${report.verdict.riskBand}) · confidence ${Math.round(report.verdict.confidence * 100)}%`)}`);
  console.log(c(toneColor, report.verdict.headline));
  console.log(c('dim', line));
  console.log(report.verdict.basis);
  console.log('');

  console.log(c('bold', 'What to do next'));
  for (const action of report.recommendedActions) console.log(`  • ${action}`);
  console.log('');

  if (report.redFlags.length > 0) {
    console.log(c('bold', `Red flags (${report.redFlags.length})`));
    for (const flag of report.redFlags) {
      console.log(`  ${c('yellow', '▲')} ${flag.label} ${c('dim', `[${flag.categoryLabel ?? flag.category}, +${flag.weight}]`)}`);
      console.log(c('gray', `    ${flag.why}`));
      for (const quote of flag.evidence.slice(0, 2)) console.log(c('gray', `    ↳ "${truncate(quote, 90)}"`));
    }
    console.log('');
  }

  if (report.credibilityCredits.length > 0) {
    console.log(c('bold', `Credibility signals (${report.credibilityCredits.length})`));
    for (const credit of report.credibilityCredits) {
      console.log(`  ${c('green', '✔')} ${credit.label} ${c('dim', `[${credit.weight}]`)}`);
    }
    console.log('');
  }

  if (report.factChecks.length > 0) {
    console.log(c('bold', `Published fact-checks (${report.factChecks.length})`));
    for (const check of report.factChecks) {
      console.log(`  ${c('bold', `[${check.normalizedRating}]`)} ${check.publisher} — ${truncate(check.claim || check.rating, 100)}`);
      if (check.url) console.log(c('blue', `    ${check.url}`));
    }
    console.log('');
  }

  if (report.evidence.length > 0) {
    console.log(c('bold', `Related sources (${report.evidence.length})`));
    for (const item of report.evidence) {
      console.log(`  • ${truncate(item.title, 90)}`);
      console.log(c('blue', `    ${item.url}`));
    }
    console.log('');
  }

  if (report.llm) {
    console.log(c('bold', `Model reasoning (${report.llm.model}, language ${report.llm.language})`));
    console.log(`  ${report.llm.reasoning}`);
    if (report.llm.translation) console.log(c('gray', `  Translation: ${truncate(report.llm.translation, 240)}`));
    console.log('');
  }

  if (report.claims.length > 0) {
    console.log(c('bold', 'Claims worth checking'));
    for (const claim of report.claims) {
      console.log(`  ${c('dim', `${Math.round(claim.checkWorthiness * 100)}%`)} ${truncate(claim.text, 110)}`);
    }
    console.log('');
  }

  console.log(c('bold', 'Evidence sources'));
  for (const [id, provider] of Object.entries(report.providers)) {
    const mark = provider.status === 'ok' ? c('green', '●') : provider.status === 'error' ? c('red', '●') : c('gray', '○');
    console.log(`  ${mark} ${provider.label ?? id} — ${provider.status}${provider.reason ? c('gray', ` (${provider.reason})`) : ''}`);
  }
  console.log('');

  console.log(c('bold', 'Suggested reply'));
  console.log(`  ${report.replySuggestion}`);
  console.log('');
  console.log(c('dim', `mode=${report.mode} · ${report.timings.total}ms · id=${report.id}`));
  console.log('');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
