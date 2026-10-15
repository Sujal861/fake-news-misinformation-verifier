import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../worker/lib/heuristics.js';
import { extractClaims } from '../worker/lib/claims.js';
import { fuse, normalizeRating, replySuggestion, recommendedActions, VERDICTS } from '../worker/lib/verdict.js';
import { parseModelJson, normalizeModelOutput } from '../worker/providers/llm.js';
import { parseResponse as parseFactChecks } from '../worker/providers/factcheck.js';
import { parseResponse as parseExaResults } from '../worker/providers/exa.js';
import { SAMPLES } from '../worker/lib/samples.js';

const sample = (id) => SAMPLES.find((item) => item.id === id).text;

function build(text, overrides = {}) {
  const heuristics = analyze(text);
  const claims = extractClaims(heuristics.ctx.text);
  return fuse({ heuristics, claims, factChecks: [], llm: null, evidence: [], ...overrides });
}

// ----------------------------------------------------------- rating parsing

test('normalizeRating maps the ratings fact-checkers actually publish', () => {
  assert.equal(normalizeRating('False'), 'false');
  assert.equal(normalizeRating('Pants on Fire!'), 'false');
  assert.equal(normalizeRating('Mostly False'), 'false');
  assert.equal(normalizeRating('Misleading'), 'misleading');
  assert.equal(normalizeRating('Mixture'), 'misleading');
  assert.equal(normalizeRating('Out of Context'), 'misleading');
  assert.equal(normalizeRating('True'), 'true');
  assert.equal(normalizeRating('Mostly True'), 'true');
  assert.equal(normalizeRating('Satire'), 'satire');
  assert.equal(normalizeRating('Unsubstantiated'), 'false');
  assert.equal(normalizeRating(''), 'unknown');
  assert.equal(normalizeRating(undefined), 'unknown');
});

// ------------------------------------------------------------------- fusion

test('a published fact-check outranks the model, even when it disagrees', () => {
  const result = build(sample('whatsapp-charging'), {
    factChecks: [{ normalizedRating: 'false', publisher: 'BOOM', claim: 'WhatsApp is not charging', url: 'https://example.com/fc' }],
    llm: { verdict: 'likely-true', confidence: 0.9 },
  });
  assert.equal(result.label, 'likely-false');
  assert.ok(result.confidence >= 0.7, `confidence was ${result.confidence}`);
  assert.equal(result.scoring.factCheckMatches, 1);
});

test('supporting fact-checks produce likely-true', () => {
  const result = build(sample('plausible-release'), {
    factChecks: [{ normalizedRating: 'true', publisher: 'Reuters', claim: 'RBI held rates', url: 'https://example.com/1' }],
  });
  assert.equal(result.label, 'likely-true');
});

test('a mixture rating reads as misleading rather than false', () => {
  const result = build(sample('miracle-cure'), {
    factChecks: [{ normalizedRating: 'misleading', publisher: 'AFP', claim: 'Papaya leaf claim', url: 'https://example.com/2' }],
  });
  assert.equal(result.label, 'misleading');
});

test('with no external evidence, heuristics never declare a message false', () => {
  for (const item of SAMPLES) {
    const result = build(item.text);
    assert.equal(result.label, 'unverified', `${item.id} returned ${result.label}`);
    assert.ok(VERDICTS[result.label]);
  }
});

test('the model verdict is used when there is no fact-check match', () => {
  const result = build(sample('miracle-cure'), {
    llm: { verdict: 'likely-false', confidence: 0.8, facts: true },
  });
  assert.equal(result.label, 'likely-false');
  assert.ok(result.confidence > 0.5);
});

test('an alarming message drags down the confidence of a positive model verdict', () => {
  const text = sample('whatsapp-charging');
  const agreeing = build(text, { llm: { verdict: 'likely-false', confidence: 0.8 } });
  const disagreeing = build(text, { llm: { verdict: 'likely-true', confidence: 0.8 } });
  assert.ok(disagreeing.confidence < agreeing.confidence, 'disagreement should cost confidence');
});

test('a message with no checkable claim is reported as such', () => {
  const result = build('ok');
  assert.equal(result.label, 'no-claim');
});

test('fusion always reports a risk score and a basis string', () => {
  const result = build(sample('hinglish-free-recharge'));
  assert.equal(typeof result.riskScore, 'number');
  assert.ok(result.basis.length > 20);
  assert.ok(result.evidenceSignals.length > 0);
  assert.equal(result.riskBand, 'high');
});

// --------------------------------------------------------------- follow-ups

/** Assemble the same report shape that the pipeline hands to the follow-up helpers. */
function reportShape(text, overrides = {}) {
  const heuristics = analyze(text);
  const verdict = fuse({
    heuristics,
    claims: extractClaims(heuristics.ctx.text),
    factChecks: [],
    llm: null,
    evidence: [],
    ...overrides,
  });
  return { verdict, heuristics, language: heuristics.ctx.language, factChecks: [], evidence: [] };
}

test('recommended actions escalate for scams and health misinformation', () => {
  const scam = recommendedActions(reportShape(sample('hinglish-free-recharge')));
  assert.ok(scam.some((action) => action.toLowerCase().includes('otp') || action.toLowerCase().includes('money')), scam.join(' | '));

  const health = recommendedActions(reportShape(sample('miracle-cure')));
  assert.ok(health.some((action) => action.includes('WHO') || action.toLowerCase().includes('health')), health.join(' | '));
});

test('the suggested reply follows the language of the original message', () => {
  const hinglish = reportShape(sample('hinglish-free-recharge'));
  assert.equal(hinglish.language.code, 'hi-Latn');
  assert.match(replySuggestion(hinglish), /forward|verify|source/i);

  assert.match(replySuggestion(reportShape(sample('plausible-release'))), /source|forward/i);
});

test('a fact-check link is included in the suggested reply', () => {
  const withCheck = reportShape(sample('miracle-cure'), {
    factChecks: [{ normalizedRating: 'false', publisher: 'AFP', claim: 'c', url: 'https://afp.com/fc-1' }],
  });
  withCheck.factChecks = [{ url: 'https://afp.com/fc-1' }];
  assert.equal(withCheck.verdict.label, 'likely-false');
  assert.match(replySuggestion(withCheck), /afp\.com\/fc-1/);
});

// ----------------------------------------------------- provider response parsing

test('fact-check responses are flattened, rated and sorted by severity', () => {
  const parsed = parseFactChecks({
    claims: [
      {
        text: 'WhatsApp will charge users',
        claimant: 'viral message',
        claimReview: [
          { textualRating: 'Mixture', url: 'https://b.example', publisher: { name: 'AltNews' }, reviewDate: '2024-01-01' },
          { textualRating: 'False', url: 'https://a.example', publisher: { name: 'BOOM' }, reviewDate: '2024-02-02' },
        ],
      },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].normalizedRating, 'false');
  assert.equal(parsed[0].publisher, 'BOOM');
  assert.equal(parsed[1].normalizedRating, 'misleading');
});

test('fact-check parsing tolerates an empty or malformed payload', () => {
  assert.deepEqual(parseFactChecks({}), []);
  assert.deepEqual(parseFactChecks(null), []);
  assert.deepEqual(parseFactChecks({ claims: [{ claimReview: [] }] }), []);
});

test('exa responses fall back to text when highlights are missing', () => {
  const parsed = parseExaResults({
    results: [
      { title: 'Story', url: 'https://reuters.com/x', highlights: ['one', 'two'] },
      { title: 'Other', url: 'https://bbc.com/y', text: '  full   text   here  ' },
    ],
  });
  assert.equal(parsed[0].snippet, 'one … two');
  assert.equal(parsed[1].snippet, 'full text here');
});

test('model JSON survives code fences and surrounding prose', () => {
  const fenced = parseModelJson('```json\n{"verdict":"misleading"}\n```');
  assert.equal(fenced.verdict, 'misleading');

  const chatty = parseModelJson('Sure! Here you go: {"verdict":"unverified"} Hope that helps.');
  assert.equal(chatty.verdict, 'unverified');

  assert.throws(() => parseModelJson('no json at all'), /not valid JSON/);
});

test('model output is coerced into a safe shape', () => {
  const normalized = normalizeModelOutput({
    verdict: 'definitely-false',
    confidence: '4',
    claims: ['a', 42, ''],
    redFlags: 'not-an-array',
    knownFactCheck: { rating: 'bogus', note: 5 },
  });
  assert.equal(normalized.verdict, 'unverified');
  assert.equal(normalized.confidence, 1);
  assert.deepEqual(normalized.claims, ['a']);
  assert.deepEqual(normalized.redFlags, []);
  assert.equal(normalized.knownFactCheck.rating, 'none');
  assert.equal(normalized.knownFactCheck.note, '');
});
