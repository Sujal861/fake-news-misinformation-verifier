/**
 * Claim extraction and check-worthiness ranking.
 *
 * We are not doing full NLP here — that is what the optional LLM step is for.
 * This module's job is to pick the handful of sentences that a human (or a
 * fact-check API) would actually want to check, and to rank them so a lookup
 * budget of N searches is spent well.
 */

import { splitSentences } from './text.js';

/** Verbs that signal a factual assertion rather than an opinion. */
const ASSERTION_VERBS = [
  'is', 'are', 'was', 'were', 'will', 'has', 'have', 'had', 'can', 'cannot',
  'announced', 'banned', 'bans', 'stopped', 'stopping', 'launched', 'approved',
  'passed', 'declared', 'confirmed', 'cures', 'cure', 'prevents', 'causes',
  'caused', 'kills', 'killed', 'died', 'charged', 'will charge', 'deleted',
  'removed', 'banned', 'free', 'giving', 'offering', 'leaked', 'resigned',
  'banned', 'arrested', 'attacked', 'warns', 'warned', 'alert', 'claims',
  'hoga', 'hogi', 'hai', 'hain', 'band', 'bana', 'banaya', 'shuru',
];

const HEDGES = [
  'i think', 'maybe', 'perhaps', 'in my opinion', 'imo', 'good morning',
  'thank you', 'please note', 'jai hind', 'namaste', 'good night',
];

/**
 * Sentences that open with an instruction are telling the reader what to do,
 * not asserting a fact. They must not consume a fact-check lookup, which ends
 * up wasting the budget on "Forward this to 10 people or ...".
 */
const INSTRUCTION_START = /^(?:please |kindly |share |forward |fwd |send |click |open |register |apply |submit |avoid |don'?t |do not |never |remember |note that |keep |bhej|bhejo|karo |share kar|forward kar|jaldi )/i;

/** Conditional threats are a manipulation device rather than a checkable claim. */
const CONDITIONAL_THREAT = /\b(?:or|otherwise|warna|nahi to)\b[^.\n]{0,40}\b(?:deleted|blocked|banned|suspended|band|will be)\b/i;

const SUPERLATIVE_BAIT = [
  'shocking', 'unbelievable', 'viral', 'breaking', 'must share', 'important',
];

/**
 * Score how worth-checking a single sentence is.
 * @returns {number} 0..1
 */
export function checkWorthiness(sentence) {
  const text = sentence.trim();
  if (text.length < 15) return 0;

  const lower = text.toLowerCase();
  let score = 0.1;

  if (ASSERTION_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(lower))) score += 0.3;
  if (/\d/.test(text)) score += 0.15;
  if (/\b\d{1,3}(?:\.\d+)?\s?%/.test(text)) score += 0.1;
  if (/(?:cancer|covid|corona|vaccine|bank|account|otp|government|law|rule|scheme|whatsapp|price|ban|tax|election|result)/i.test(text)) score += 0.2;
  if (SUPERLATIVE_BAIT.some((bait) => lower.includes(bait))) score += 0.08;
  if (/(?:said|according to|reported|announced|confirmed|declared)/i.test(lower)) score += 0.12;
  if (/\b(?:will be|has been|is being|going to)\b/i.test(lower)) score += 0.1;

  if (INSTRUCTION_START.test(text)) score -= 0.45;
  if (CONDITIONAL_THREAT.test(text)) score -= 0.3;
  if (HEDGES.some((hedge) => lower.includes(hedge))) score -= 0.2;
  if (text.length < 25) score -= 0.1;

  return Math.max(0, Math.min(1, round3(score)));
}

/**
 * Extract and rank checkable claims.
 * @param {string} text
 * @param {{limit?: number}} [options]
 */
export function extractClaims(text, options = {}) {
  const limit = options.limit ?? 5;
  const sentences = splitSentences(text);
  const scored = sentences
    .map((sentence, index) => ({
      index,
      text: sentence.length > 300 ? `${sentence.slice(0, 297)}...` : sentence,
      checkWorthiness: checkWorthiness(sentence),
    }))
    .filter((claim) => claim.checkWorthiness >= 0.25);

  scored.sort((a, b) => b.checkWorthiness - a.checkWorthiness || a.index - b.index);

  // Keep the original reading order among the winners so the report reads
  // naturally instead of jumping around the message.
  return scored.slice(0, limit).sort((a, b) => a.index - b.index);
}

/** A short, quotable handle for a claim, used as a lookup query. */
export function claimQuery(claim, maxLength = 120) {
  const cleaned = claim
    .replace(/^[\s"'“”‘’\-–—*•>#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trim()}…` : cleaned;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
