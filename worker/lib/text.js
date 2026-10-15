/**
 * Text normalization, script/language detection and tokenization.
 *
 * Pure ESM with no Node or Cloudflare APIs so the identical module runs inside
 * the Worker, inside the CLI and inside `node --test`.
 */

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

const SCRIPT_RANGES = [
  ['Devanagari', /[\u0900-\u097f]/],
  ['Bengali', /[\u0980-\u09ff]/],
  ['Gurmukhi', /[\u0a00-\u0a7f]/],
  ['Gujarati', /[\u0a80-\u0aff]/],
  ['Tamil', /[\u0b80-\u0bff]/],
  ['Telugu', /[\u0c00-\u0c7f]/],
  ['Kannada', /[\u0c80-\u0cff]/],
  ['Malayalam', /[\u0d00-\u0d7f]/],
  ['Arabic', /[\u0600-\u06ff\u0750-\u077f]/],
  ['Hebrew', /[\u0590-\u05ff]/],
  ['Cyrillic', /[\u0400-\u04ff]/],
  ['Greek', /[\u0370-\u03ff]/],
  ['Han', /[\u4e00-\u9fff\u3400-\u4dbf]/],
  ['Hiragana', /[\u3040-\u309f]/],
  ['Katakana', /[\u30a0-\u30ff]/],
  ['Hangul', /[\uac00-\ud7af\u1100-\u11ff]/],
  ['Thai', /[\u0e00-\u0e7f]/],
];

const SCRIPT_TO_LANGUAGE = {
  Devanagari: 'hi',
  Bengali: 'bn',
  Gurmukhi: 'pa',
  Gujarati: 'gu',
  Tamil: 'ta',
  Telugu: 'te',
  Kannada: 'kn',
  Malayalam: 'ml',
  Arabic: 'ar',
  Hebrew: 'he',
  Cyrillic: 'ru',
  Greek: 'el',
  Han: 'zh',
  Hiragana: 'ja',
  Katakana: 'ja',
  Hangul: 'ko',
  Thai: 'th',
};

/** Romanized Hindi/Urdu markers. Deliberately high-precision, not exhaustive. */
const HINGLISH_MARKERS = [
  'hai', 'hain', 'nahi', 'nahin', 'kya', 'aap', 'hum', 'sab', 'sabko', 'bhejo',
  'karo', 'karna', 'kijiye', 'kripya', 'jaldi', 'turant', 'aaj', 'kal', 'abhi',
  'mat', 'bhi', 'aur', 'ke', 'ki', 'ka', 'se', 'mein', 'par', 'tha', 'the',
  'hoga', 'hogi', 'raha', 'rahi', 'gaya', 'gayi', 'batao', 'share', 'forward',
  'bhai', 'didi', 'bhaiya', 'ji', 'log', 'logon', 'desh', 'sarkar', 'modi',
  'paisa', 'paisae', 'khana', 'pani', 'dawa', 'ilaj', 'bachao', 'khabar',
  'jankari', 'zaroori', 'jaroori', 'sach', 'jhooth', 'video', 'dekh', 'dekho',
  'padho', 'padhe', 'sun', 'suno', 'chalo', 'aao', 'wala', 'wali', 'banaya',
  'hoga', 'kro', 'kijiyega', 'dhyan', 'savdhan', 'sawdhan', 'samay',
];

const EMOJI = /[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}\u{fe0f}\u{2190}-\u{21ff}]/gu;

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bit.do',
  'wa.me', 'chat.whatsapp.com', 't.me', 'linktr.ee', 'adf.ly', 'shorte.st',
]);

const AUTHORITATIVE_TLDS = ['.gov', '.gov.in', '.nic.in', '.mil', '.gov.uk', '.edu'];
const AUTHORITATIVE_HOSTS = new Set([
  'who.int', 'pib.gov.in', 'cdc.gov', 'nih.gov', 'nasa.gov', 'un.org',
  'icmr.gov.in', 'rbi.org.in', 'eci.gov.in', 'mygov.in', 'india.gov.in',
  'factcheck.org', 'snopes.com', 'politifact.com', 'boomlive.in',
  'altnews.in', 'factly.in', 'vishvasnews.com', 'afp.com', 'reuters.com',
]);

/**
 * Normalize raw input: strip zero-width/invisible characters that are commonly
 * used to sneak a message past keyword filters, unify whitespace, and keep the
 * original for display.
 */
export function normalize(raw) {
  const original = String(raw ?? '');
  const cleaned = original
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    original,
    text: cleaned,
    strippedInvisibles: original.length !== cleaned.length,
  };
}

/** Detect the dominant script and a coarse language guess. */
export function detectLanguage(text) {
  const counts = {};
  let scripted = 0;
  let total = 0;

  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    total += 1;
    if (/[a-z]/i.test(char)) continue;
    for (const [script, re] of SCRIPT_RANGES) {
      if (re.test(char)) {
        counts[script] = (counts[script] ?? 0) + 1;
        scripted += 1;
        break;
      }
    }
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topScript, topCount] = ranked[0] ?? [null, 0];
  const scriptShare = total === 0 ? 0 : scripted / total;

  if (topScript && scriptShare > 0.15) {
    return {
      code: SCRIPT_TO_LANGUAGE[topScript] ?? 'und',
      script: topScript,
      confidence: round2(Math.min(1, scriptShare + topCount / Math.max(total, 1))),
      label: `${SCRIPT_TO_LANGUAGE[topScript] ?? 'unknown'} (${topScript} script)`,
    };
  }

  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const hits = words.filter((w) => HINGLISH_MARKERS.includes(w)).length;
  const hinglishShare = words.length === 0 ? 0 : hits / words.length;

  if (words.length >= 6 && hits >= 3 && hinglishShare > 0.12) {
    return {
      code: 'hi-Latn',
      script: 'Latin',
      confidence: round2(Math.min(0.95, 0.5 + hinglishShare)),
      label: 'Hindi/Urdu written in Latin script (Hinglish)',
    };
  }

  return {
    code: 'en',
    script: 'Latin',
    confidence: 0.6,
    label: 'English (Latin script)',
  };
}

/** Pull URLs out of the text plus a little metadata about each. */
export function extractUrls(text) {
  const matches = text.match(/\b(?:https?:\/\/|www\.)[^\s<>()"'`]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>()"'`]*/gi) ?? [];
  const seen = new Set();
  const urls = [];

  for (const match of matches) {
    const trimmed = match.replace(/[.,;:!?)\]}"']+$/, '');
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);

    let host = '';
    try {
      host = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }

    urls.push({
      raw: trimmed,
      host,
      shortened: SHORTENER_HOSTS.has(host),
      authoritative: host !== '' && isAuthoritativeHost(host),
    });
  }

  return urls;
}

export function isAuthoritativeHost(host) {
  if (AUTHORITATIVE_HOSTS.has(host)) return true;
  if (AUTHORITATIVE_TLDS.some((tld) => host.endsWith(tld))) return true;
  return false;
}

/** Split the message into sentences across Latin and Indic punctuation. */
export function splitSentences(text) {
  return text
    .split(/(?<=[.!?।॥؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function countEmoji(text) {
  return (text.match(EMOJI) ?? []).length;
}

export function hasEmoji(text) {
  return EMOJI.test(text);
}

/** Extract phone numbers, UPI ids and bank details that appear in scam forwards. */
export function extractPaymentIndicators(text) {
  return {
    upiIds: unique(text.match(/\b[a-z0-9._-]{2,}@(?:ybl|paytm|okaxis|okicici|oksbi|okhdfcbank|upi|apl|ibl|axl)\b/gi) ?? []),
    phones: unique(text.match(/(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g) ?? []),
    amounts: unique(text.match(/(?:rs\.?|inr|₹)\s?\d[\d,]{2,}/gi) ?? []),
  };
}

function unique(list) {
  return [...new Set(list.map((item) => item.trim()))];
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function buildContext(raw) {
  const { original, text, strippedInvisibles } = normalize(raw);
  const lower = text.toLowerCase();
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  const urls = extractUrls(text);
  const sentences = splitSentences(text);
  const language = detectLanguage(text);

  const letters = text.replace(/[^\p{L}]/gu, '');
  const upperLetters = text.replace(/[^\p{Lu}]/gu, '');
  const capsRatio = letters.length === 0 ? 0 : upperLetters.length / letters.length;

  return {
    original,
    text,
    lower,
    words,
    sentences,
    urls,
    language,
    strippedInvisibles,
    capsRatio: round2(capsRatio),
    emojiCount: countEmoji(text),
    exclamationRuns: (text.match(/[!?]{2,}/g) ?? []).length,
    payment: extractPaymentIndicators(text),
    hasNamedOutlet: /\b(reuters|associated press|\bap\b|bbc|the hindu|indian express|times of india|ndtv|ani|pti|press trust|who|world health organization|cdc|icmr|nasa|unicef|pib|fact check)\b/i.test(text),
  };
}
