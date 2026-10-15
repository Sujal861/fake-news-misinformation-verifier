/**
 * Verdict fusion.
 *
 * Three evidence sources of very different trustworthiness feed one verdict:
 *
 *   1. Fact-check reviews from a curated database  -> strongest signal
 *   2. An LLM's reasoning over the claim (and any retrieved evidence)
 *   3. Offline red-flag heuristics -> a *risk* signal, never proof of falsity
 *
 * The ordering matters and is enforced here: heuristics alone can raise alarm
 * but can never declare something false, because style is not evidence. That
 * keeps the tool honest — its most confident output is always anchored to a
 * human fact-check or a cited source.
 */

import { round2 } from './text.js';

// `title` is for humans; the object key is the stable machine label that the
// rest of the app (and the API contract) keys off.
export const VERDICTS = {
  'likely-false': { title: 'Likely false', tone: 'danger', order: 0 },
  misleading: { title: 'Misleading', tone: 'warn', order: 1 },
  unverified: { title: 'Unverified', tone: 'neutral', order: 2 },
  'likely-true': { title: 'Likely true', tone: 'ok', order: 3 },
  'no-claim': { title: 'Nothing to check', tone: 'neutral', order: 4 },
};

/**
 * Map the free-text ratings fact-checkers publish onto our buckets.
 *
 * Order is deliberate. A `misleading` rating is its own bucket, not `false`:
 * both count as falsity evidence when the verdict is fused, but keeping them
 * apart is what lets the report say "missing context" instead of "fabricated".
 * The substring passes run false-leaning before context-leaning so that
 * "Mostly False" lands in `false` rather than being read as "mixed".
 */
export function normalizeRating(rating) {
  const value = String(rating ?? '').toLowerCase().trim();
  if (value === '') return 'unknown';

  const falseExact = [
    'false', 'incorrect', 'fake', 'pants on fire', 'falso', 'falsch', 'फ़र्ज़ी',
    'jhooth', 'manipulated', 'distorted', 'altered', 'scam', 'hoax',
    'fabricated', 'no evidence', 'unsupported', 'unsubstantiated',
    'not true', 'untrue', 'wrong', 'debunked', 'बेबुनियाद', 'भ्रामक',
  ];
  const trueExact = ['true', 'correct', 'accurate', 'सही', 'सच', 'supported', 'confirmed', 'verified'];
  const misleading = [
    'misleading', 'missing context', 'needs context', 'out of context',
    'exaggerated', 'mixture', 'mixed', 'partly', 'half true',
  ];
  const satire = ['satire', 'parody', 'humor', 'humour', 'opinion', 'labelled satire'];

  if (falseExact.some((needle) => value === needle)) return 'false';
  if (trueExact.some((needle) => value === needle)) return 'true';
  if (satire.some((needle) => value.includes(needle))) return 'satire';
  if (falseExact.some((needle) => value.includes(needle))) return 'false';
  if (misleading.some((needle) => value.includes(needle))) return 'misleading';
  if (trueExact.some((needle) => value.includes(needle))) return 'true';
  return 'unknown';
}

function tally(ratings) {
  const counts = { false: 0, misleading: 0, satire: 0, true: 0, unknown: 0 };
  for (const rating of ratings) counts[rating] = (counts[rating] ?? 0) + 1;
  return counts;
}

/**
 * @param {object} input
 * @param {object} input.heuristics  Result of `analyze()`.
 * @param {Array}  [input.factChecks]
 * @param {object} [input.llm]
 * @param {Array}  [input.evidence]
 * @param {Array}  [input.claims]
 */
export function fuse({ heuristics, factChecks = [], llm = null, evidence = [], claims = [] }) {
  const ratingCounts = tally(factChecks.map((check) => check.normalizedRating ?? 'unknown'));
  const strongFalsity = ratingCounts.false;
  const softFalsity = ratingCounts.misleading + ratingCounts.satire;
  const supporting = ratingCounts.true;

  const signals = [];
  let verdict;
  let confidence;
  let basis;

  if (claims.length === 0 && heuristics.ctx.text.length < 20) {
    verdict = 'no-claim';
    confidence = 0.6;
    basis = 'The message is too short to contain a checkable claim.';
    signals.push(basis);
  } else if (strongFalsity + softFalsity > 0 && strongFalsity + softFalsity >= supporting) {
    verdict = strongFalsity > 0 ? 'likely-false' : 'misleading';
    confidence = clamp(0.72 + 0.06 * (strongFalsity + softFalsity) - 0.05 * supporting, 0.6, 0.93);
    basis = `Matched ${strongFalsity + softFalsity} published fact-check review(s) rating this claim false or misleading.`;
    signals.push(basis);
  } else if (supporting > 0 && strongFalsity + softFalsity === 0) {
    verdict = 'likely-true';
    confidence = clamp(0.62 + 0.07 * supporting, 0.6, 0.85);
    basis = `Matched ${supporting} published fact-check review(s) supporting this claim.`;
    signals.push(basis);
  } else if (llm && llm.verdict && VERDICTS[llm.verdict]) {
    verdict = llm.verdict;
    confidence = llmConfidence(llm, heuristics);
    basis = 'Verdict comes from model reasoning over the claim; the offline red-flag scan is used to calibrate confidence.';
    signals.push(basis);
  } else {
    // Heuristics only. Style can raise alarm but cannot establish falsity, so
    // the strongest thing we say without external evidence is "unverified".
    verdict = 'unverified';
    confidence = clamp(0.3 + heuristics.riskScore / 400, 0.3, 0.55);
    basis = heuristics.riskScore >= 50
      ? 'No authoritative source was reachable, so this is a risk assessment of the message itself, not a factual ruling.'
      : 'Nothing checked the claim against external sources, so this is a risk assessment of the message itself.';
    signals.push(basis);
  }

  if (heuristics.riskScore >= 50 && (verdict === 'likely-true' || verdict === 'unverified')) {
    confidence = round2(Math.max(0.3, confidence - 0.08));
    signals.push('The message carries manipulative wording, which lowers confidence in its framing.');
  }
  if (evidence.length > 0) {
    signals.push(`${evidence.length} related web source(s) were retrieved as supporting context.`);
  }

  return {
    label: verdict,
    title: VERDICTS[verdict].title,
    tone: VERDICTS[verdict].tone,
    order: VERDICTS[verdict].order,
    confidence: round2(confidence),
    riskScore: heuristics.riskScore,
    riskBand: heuristics.band.label,
    headline: headlineFor(verdict, heuristics),
    basis,
    evidenceSignals: signals,
    ratingCounts,
    scoring: {
      rawWeight: heuristics.rawWeight,
      riskScore: heuristics.riskScore,
      factCheckMatches: factChecks.length,
      llmUsed: Boolean(llm),
      webEvidence: evidence.length,
    },
  };
}

function llmConfidence(llm, heuristics) {
  const stated = typeof llm.confidence === 'number' ? llm.confidence : 0.6;
  let value = clamp(stated, 0.2, 0.95);
  const alarming = heuristics.riskScore >= 65;
  const llmSaysTrue = llm.verdict === 'likely-true';

  // The model and the heuristics disagreeing is itself information: it means
  // the message is stylistically manipulative in a way the model read past, or
  // the model is crediting a claim the wording cannot support.
  if (alarming && llmSaysTrue) value -= 0.2;
  if (!alarming && llm.verdict === 'likely-false') value -= 0.1;
  if (llm.evidenceUsed) value += 0.03;
  return round2(clamp(value, 0.2, 0.95));
}

function headlineFor(verdict, heuristics) {
  const risk = heuristics.band.headline;
  switch (verdict) {
    case 'likely-false':
      return 'Likely false — fact-checkers have reviewed this claim';
    case 'misleading':
      return 'Misleading — this has been rated false or missing context';
    case 'likely-true':
      return 'Likely true — a published review supports this claim';
    case 'no-claim':
      return 'Nothing checkable in this message';
    default:
      if (heuristics.riskScore >= 75) return `${risk} — no authoritative source found to settle it`;
      if (heuristics.riskScore >= 25) return 'Unverified — some warning signs, but nothing conclusive';
      return 'No manipulation markers found — not independently verified';
  }
}

/**
 * Concrete next steps for the reader, ordered by what actually helps.
 */
export function recommendedActions(result) {
  const actions = [];
  const { verdict, heuristics } = result;

  if (verdict.label === 'likely-false' || verdict.label === 'misleading') {
    actions.push('Do not forward this message. Reply to the sender with the fact-check link instead.');
  } else if (verdict.label === 'unverified' && heuristics.riskScore >= 50) {
    actions.push('Hold off forwarding. The wording shows several manipulation markers and nothing confirms the claim.');
  } else if (verdict.label === 'unverified') {
    actions.push('Check the original source before forwarding; this tool found no evidence either way.');
  } else {
    actions.push('The claim appears supported — still link the original source when you share it.');
  }

  if (heuristics.matched.some((hit) => hit.id === 'payment-solicitation' || hit.id === 'credential-phishing')) {
    actions.push('Never send money, an OTP or a PIN to anyone who contacted you through a forward. Report it at cybercrime.gov.in.');
  }
  if (heuristics.matched.some((hit) => hit.id === 'pseudoscience-cure' || hit.id === 'vaccine-conspiracy')) {
    actions.push('For health claims, check the WHO or your national health authority page before acting on it.');
  }
  if (heuristics.matched.some((hit) => hit.id === 'shortener-link' || hit.id === 'clickbait-link')) {
    actions.push('Expand shortened links before opening them — the destination is the part that matters.');
  }
  if (result.factChecks?.length > 0) {
    actions.push('Read the full fact-check before making up your mind; ratings can be about one part of a claim.');
  }

  return actions.slice(0, 4);
}

/**
 * A ready-to-send reply the reader can paste back into the chat, in the same
 * language family as the original message.
 */
export function replySuggestion(result) {
  const language = result.language?.code ?? 'en';
  const indic = language === 'hi' || language === 'hi-Latn' || language.startsWith('hi');
  const link = result.factChecks?.[0]?.url ?? result.evidence?.[0]?.url ?? '';
  const label = result.verdict.label;

  if (indic) {
    if (label === 'likely-false' || label === 'misleading') {
      return `Bhai, ye message maine verify kiya — is claim ko fact-checkers ne ${label === 'likely-false' ? 'false' : 'misleading'} bataya hai.${link ? ` Proof: ${link}` : ''} Forward karne se pehle ek baar check kar lena.`;
    }
    if (label === 'likely-true') {
      return `Ye claim sahi lag raha hai, par original source link karna better hai.${link ? ` Source: ${link}` : ''}`;
    }
    return `Is message ka koi authoritative source nahi mila. Bina verify kiye forward na karein.${link ? ` Related: ${link}` : ''}`;
  }

  if (label === 'likely-false' || label === 'misleading') {
    return `I checked this before forwarding: fact-checkers rated the claim ${label === 'likely-false' ? 'false' : 'misleading'}.${link ? ` Source: ${link}` : ''}`;
  }
  if (label === 'likely-true') {
    return `This one looks accurate, but it is worth linking the original source.${link ? ` Source: ${link}` : ''}`;
  }
  return `I could not find an authoritative source for this. Please do not forward it until someone verifies it.${link ? ` Closest source found: ${link}` : ''}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
