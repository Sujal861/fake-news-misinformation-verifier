import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { offlineReport, buildQueries, PROVIDER_META } from '../worker/lib/offline.js';
import { verify, PROVIDERS } from '../worker/lib/verify.js';
import * as factcheck from '../worker/providers/factcheck.js';
import * as exa from '../worker/providers/exa.js';
import * as llm from '../worker/providers/llm.js';
import { SAMPLES } from '../worker/lib/samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAM =
  'give me 10000rsd I will retun imlinando;ljasf and share this message to 100 people I will giv epou 30000';

/**
 * Load public/engine.js the way a browser would: as a classic script.
 *
 * The web globals have to be supplied explicitly. A bare vm context has no
 * `URL`, and the engine resolves links with it — without it, link-based signals
 * silently stop firing, which made the bundle look like it disagreed with the
 * source when the sandbox was the thing that was wrong.
 */
function loadEngineBundle() {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    crypto,
    console,
    setTimeout,
    clearTimeout,
  });
  // A top-level `var` in a browser becomes a window property; make the sandbox
  // behave the same way.
  vm.runInContext('globalThis.window = globalThis', context);
  return readFile(join(root, 'public', 'engine.js'), 'utf8').then((source) => {
    vm.runInContext(source, context);
    return context.ForwardCheckEngine;
  });
}

// --------------------------------------------------- one engine, two runtimes

test('the provider metadata matches the provider modules', () => {
  const modules = { factcheck, exa, llm };
  assert.deepEqual(
    PROVIDER_META.map((meta) => meta.id).sort(),
    PROVIDERS.map((provider) => provider.id).sort(),
  );
  for (const meta of PROVIDER_META) {
    assert.equal(modules[meta.id].id, meta.id, `${meta.id} id drifted`);
    assert.equal(modules[meta.id].label, meta.label, `${meta.id} label drifted`);
  }
});

test('the offline report matches what the worker pipeline returns with no keys', async () => {
  const local = offlineReport(SCAM);
  const worker = await verify(SCAM, {}, { useLive: false });

  assert.equal(local.verdict.label, worker.verdict.label);
  assert.equal(local.verdict.riskScore, worker.verdict.riskScore);
  assert.equal(local.verdict.riskBand, worker.verdict.riskBand);
  assert.equal(local.verdict.headline, worker.verdict.headline);
  assert.deepEqual(local.redFlags.map((flag) => flag.id), worker.redFlags.map((flag) => flag.id));
  assert.deepEqual(local.claims, worker.claims);
  assert.deepEqual(local.queries, worker.queries);
  assert.equal(local.replySuggestion, worker.replySuggestion);
  assert.deepEqual(local.recommendedActions, worker.recommendedActions);
  assert.equal(local.language.code, worker.language.code);
});

test('every sample verifies offline and stays unverified', async () => {
  for (const sample of SAMPLES) {
    const report = offlineReport(sample.text);
    assert.equal(report.verdict.label, 'unverified', `${sample.id} returned ${report.verdict.label}`);
    assert.equal(report.mode, 'offline-heuristics');
    assert.equal(report.servedBy, 'browser');
  }
});

test('the offline report carries every field the page renders', () => {
  const report = offlineReport(SCAM);

  for (const key of ['id', 'createdAt', 'input', 'language', 'verdict', 'claims', 'redFlags', 'credibilityCredits', 'factChecks', 'evidence', 'llm', 'queries', 'providers', 'timings', 'mode', 'recommendedActions', 'replySuggestion']) {
    assert.ok(key in report, `report is missing ${key}`);
  }
  assert.equal(typeof report.timings.total, 'number');
  assert.equal(report.language.label.length > 0, true);
  assert.equal(report.verdict.basis.length > 20, true);

  // The page counts contributing providers by status.
  assert.equal(Object.keys(report.providers).length, PROVIDER_META.length);
  for (const provider of Object.values(report.providers)) {
    assert.equal(provider.status, 'skipped');
    assert.ok(provider.reason.includes('not set'));
  }
});

test('the detection gap from the reported bug stays closed', () => {
  const report = offlineReport(SCAM);
  const flags = report.redFlags.map((flag) => flag.id);

  assert.ok(flags.includes('chain-letter-threat'), 'share-to-100-people pressure was not flagged');
  assert.ok(flags.includes('money-for-money-promise'), 'money in / more money out was not flagged');
  assert.ok(report.verdict.riskScore >= 45, `risk was only ${report.verdict.riskScore}`);
});

test('ordinary messages are not flagged as scams', () => {
  const ordinary = [
    'Hey, lend me 200 rupees, I will return it tomorrow evening.',
    'Please give me your number so I can call you back.',
    'The new laptop costs 79999 rs at the Mumbai store, invoice attached.',
    'Meeting moved to 4pm in room 12, see you there.',
  ];

  for (const text of ordinary) {
    const report = offlineReport(text);
    assert.equal(report.redFlags.length, 0, `"${text}" flagged ${report.redFlags.map((f) => f.id).join(', ')}`);
  }
});

test('buildQueries produces searchable queries, and nothing for a too-short message', () => {
  // Under the minimum length there is nothing worth spending a lookup on.
  assert.deepEqual(buildQueries([], 'Short.'), []);

  const queries = buildQueries([], SCAM);
  assert.ok(queries.length >= 1);
  for (const query of queries) assert.ok(query.length >= 8, `"${query}" is too short to search`);
  assert.equal(queries.length, new Set(queries.map((query) => query.toLowerCase())).size, 'queries must be unique');
});

// -------------------------------------------------------- the shipped bundle

test('public/engine.js exposes a working offline engine', async () => {
  const engine = await loadEngineBundle();

  assert.ok(engine, 'engine.js did not define window.ForwardCheckEngine');
  for (const name of ['offlineReport', 'buildQueries', 'SAMPLES', 'PROVIDER_META']) {
    assert.ok(engine[name] !== undefined, `engine.js does not export ${name}`);
  }
  assert.equal(engine.SAMPLES.length, SAMPLES.length);
});

test('the shipped bundle reports the same verdict as the source engine', async () => {
  const engine = await loadEngineBundle();
  const bundled = engine.offlineReport(SCAM);
  const source = offlineReport(SCAM);

  // Compared as strings: values from the bundle's vm realm have their own Array
  // prototype, so deepStrictEqual would reject arrays that are in fact equal.
  const ids = (report) => report.redFlags.map((flag) => flag.id).join(',');
  const claimTexts = (report) => report.claims.map((claim) => claim.text).join(' | ');

  assert.equal(bundled.verdict.label, source.verdict.label);
  assert.equal(bundled.verdict.riskScore, source.verdict.riskScore);
  assert.equal(bundled.verdict.headline, source.verdict.headline);
  assert.equal(ids(bundled), ids(source));
  assert.equal(claimTexts(bundled), claimTexts(source));
  assert.equal(bundled.replySuggestion, source.replySuggestion);
  assert.equal(bundled.mode, source.mode);

  for (const sample of SAMPLES) {
    const fromBundle = engine.offlineReport(sample.text);
    const fromSource = offlineReport(sample.text);
    assert.equal(fromBundle.verdict.riskScore, fromSource.verdict.riskScore, `${sample.id} risk drifted`);
    assert.equal(ids(fromBundle), ids(fromSource), `${sample.id} flags drifted`);
  }
});

test('the browser bundle references no Node APIs', async () => {
  const source = await readFile(join(root, 'public', 'engine.js'), 'utf8');
  for (const needle of ['require(', 'process.env', 'node:fs', '__dirname']) {
    assert.equal(source.includes(needle), false, `engine.js references ${needle}`);
  }
});
