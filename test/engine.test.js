import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, detectLanguage, extractUrls, buildContext, extractPaymentIndicators } from '../worker/lib/text.js';
import { analyze, squash, riskBand } from '../worker/lib/heuristics.js';
import { extractClaims, checkWorthiness, claimQuery } from '../worker/lib/claims.js';
import { SAMPLES } from '../worker/lib/samples.js';

const sample = (id) => SAMPLES.find((item) => item.id === id).text;

// ------------------------------------------------------------------- text.js

test('normalize strips zero-width and bidi characters', () => {
  const { text, strippedInvisibles, original } = normalize('hello\u200b\u202eworld');
  assert.equal(text, 'helloworld');
  assert.equal(strippedInvisibles, true);
  assert.equal(original.includes('\u200b'), true);
});

test('normalize collapses whitespace but preserves paragraph breaks', () => {
  const { text } = normalize('a   b\r\n\r\n\r\n\r\nc');
  assert.equal(text, 'a b\n\nc');
});

test('detectLanguage identifies Devanagari, Hinglish and English', () => {
  assert.equal(detectLanguage('सरकार ने नई योजना की घोषणा की है, सबको बताओ').code, 'hi');
  assert.equal(detectLanguage('Bhai ye jaldi sabko bhejo, bahut zaroori khabar hai').code, 'hi-Latn');
  assert.equal(detectLanguage('The central bank held the repo rate unchanged in Mumbai').code, 'en');
});

test('extractUrls resolves hosts and flags shorteners and official domains', () => {
  const urls = extractUrls('see https://bit.ly/x and https://www.rbi.org.in/notice and https://reuters.com/story.');
  assert.equal(urls.length, 3);
  assert.equal(urls[0].shortened, true);
  assert.equal(urls[1].authoritative, true);
  assert.equal(urls[2].host, 'reuters.com');
  assert.equal(urls[2].raw, 'https://reuters.com/story');
});

test('extractPaymentIndicators finds UPI ids, phones and amounts', () => {
  const found = extractPaymentIndicators('send Rs 5,000 to 9876543210@ybl or call 9876543210');
  assert.deepEqual(found.upiIds, ['9876543210@ybl']);
  assert.deepEqual(found.phones, ['9876543210']);
  assert.equal(found.amounts.length, 1);
});

test('buildContext reports capitalisation and named outlets', () => {
  const ctx = buildContext('IMPORTANT: Reuters confirmed the story');
  assert.ok(ctx.capsRatio > 0.2);
  assert.equal(ctx.hasNamedOutlet, true);
});

// -------------------------------------------------------------- heuristics.js

test('squash saturates and riskBand thresholds line up', () => {
  assert.equal(squash(0), 0);
  assert.equal(squash(-10), 0);
  assert.ok(squash(6) < squash(20));
  assert.ok(squash(20) < squash(40));
  assert.ok(squash(200) <= 100);
  assert.equal(riskBand(80).id, 'high');
  assert.equal(riskBand(10).id, 'low');
});

test('the WhatsApp-charging forward is flagged with the expected signals', () => {
  const result = analyze(sample('whatsapp-charging'));
  const ids = result.matched.map((hit) => hit.id);
  assert.ok(ids.includes('fake-platform-policy'), `expected fake-platform-policy in ${ids}`);
  assert.ok(ids.includes('chain-letter-threat'), `expected chain-letter-threat in ${ids}`);
  assert.ok(ids.includes('urgency-deletion'), `expected urgency-deletion in ${ids}`);
  assert.ok(ids.includes('forwarded-marker'), `expected forwarded-marker in ${ids}`);
  assert.equal(result.band.id, 'high');
  assert.ok(result.riskScore >= 75);
});

test('the miracle-cure forward trips health and conspiracy signals', () => {
  const result = analyze(sample('miracle-cure'));
  const ids = result.matched.map((hit) => hit.id);
  assert.ok(ids.includes('pseudoscience-cure'));
  assert.ok(ids.includes('generic-conspiracy'));
  assert.ok(ids.includes('anonymous-authority'));
  assert.equal(result.band.id, 'high');
});

test('the Hinglish recharge scam is caught by romanised patterns', () => {
  const result = analyze(sample('hinglish-free-recharge'));
  const ids = result.matched.map((hit) => hit.id);
  assert.ok(ids.includes('free-giveaway'), `expected free-giveaway in ${ids}`);
  assert.ok(ids.includes('credential-phishing'), `expected credential-phishing in ${ids}`);
  assert.ok(ids.includes('shortener-link'));
  assert.ok(ids.includes('time-pressure'));
  assert.ok(result.riskScore >= 70);
});

test('payment solicitation is detected from a UPI id in the text', () => {
  const result = analyze('Please send Rs 2000 to help, UPI: helper@okicici');
  assert.ok(result.matched.some((hit) => hit.id === 'payment-solicitation'));
});

test('a sourced news-style message scores no risk and earns credibility credits', () => {
  const result = analyze(sample('plausible-release'));
  assert.equal(result.riskScore, 0, `expected risk 0, matched: ${JSON.stringify(result.matched.map((h) => h.id))}`);
  const creditIds = result.credits.map((hit) => hit.id);
  assert.ok(creditIds.includes('cites-named-outlet'));
  assert.ok(creditIds.includes('authoritative-link'));
  assert.ok(creditIds.includes('precise-provenance'));
});

test('a vague government announcement is only flagged without a named outlet', () => {
  const vague = analyze('The government has announced that all citizens will get free electricity.');
  assert.ok(vague.matched.some((hit) => hit.id === 'vague-government-announcement'));

  const sourced = analyze('The government has announced a new scheme, Reuters reports.');
  assert.ok(!sourced.matched.some((hit) => hit.id === 'vague-government-announcement'));
});

test('hidden characters in an otherwise clean message are reported', () => {
  const result = analyze('Good morning everyone\u200b\u200b');
  assert.ok(result.matched.some((hit) => hit.id === 'hidden-characters'));
});

test('every matched (positive) signal carries evidence and a reason', () => {
  for (const id of ['whatsapp-charging', 'miracle-cure', 'hinglish-free-recharge']) {
    const result = analyze(sample(id));
    assert.ok(result.matched.length > 0, `${id} produced no signals`);
    for (const hit of result.matched) {
      assert.ok(hit.evidence.length > 0, `${id}/${hit.id} has no evidence`);
      assert.ok(typeof hit.why === 'string' && hit.why.length > 10, `${id}/${hit.id} has no explanation`);
      assert.ok(hit.weight > 0);
    }
  }
});

// ------------------------------------------------------------------ claims.js

test('checkWorthiness ranks factual assertions above greetings and instructions', () => {
  assert.ok(checkWorthiness('WhatsApp will charge Rs 500 per year starting January.') > 0.5);
  assert.ok(checkWorthiness('Good morning everyone, have a nice day') < 0.25);
  assert.ok(checkWorthiness('Please forward this to 10 people') < 0.25);
});

test('extractClaims returns ranked claims in reading order', () => {
  const claims = extractClaims(sample('whatsapp-charging'));
  assert.ok(claims.length > 0);
  assert.ok(claims.length <= 5);
  for (let i = 1; i < claims.length; i += 1) {
    assert.ok(claims[i].index > claims[i - 1].index, 'claims out of reading order');
  }
});

test('claimQuery trims decorative prefixes and long claims', () => {
  assert.equal(claimQuery('  — Hello world  '), 'Hello world');
  assert.equal(claimQuery('x'.repeat(300)).length, 120);
});

test('extractClaims copes with text that has no claims', () => {
  assert.deepEqual(extractClaims('ok'), []);
  assert.deepEqual(extractClaims(''), []);
});
