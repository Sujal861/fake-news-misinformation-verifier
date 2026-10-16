/**
 * The offline red-flag engine.
 *
 * Every signal is a small, explainable rule: it either fires (and we report the
 * literal substring that triggered it) or it does not. Nothing here touches the
 * network, which is what keeps the verifier useful on a phone with no API keys
 * and with no connectivity.
 *
 * Weights are additive and then squashed into a 0-100 risk score. Positive
 * weights raise risk; negative weights are credibility credits. The score
 * describes the message's rhetoric, never the truth of its claim.
 */

import { buildContext, round2 } from './text.js';

/**
 * @typedef {object} Signal
 * @property {string} id
 * @property {string} label       Human-facing name shown in the UI.
 * @property {'manipulation'|'scam'|'health'|'authority'|'style'|'provenance'|'credibility'} category
 * @property {number} weight      Positive = raises risk, negative = credibility credit.
 * @property {string} why         Why this pattern is suspicious.
 * @property {(ctx: object) => string[]} detect  Returns matched evidence snippets.
 */

/** @type {Signal[]} */
export const SIGNALS = [
  // ---------------------------------------------------------------- provenance
  {
    id: 'forwarded-marker',
    label: 'Marked as a forwarded / chain message',
    category: 'provenance',
    weight: 10,
    why: 'Chain forwards lose the original author, date and context, so the claim cannot be checked at its source.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /^\s*(?:fwd|fw|forwarded)\s*[:>-]/gim),
      ...matchAll(ctx.text, /forwarded (?:many times|as received)/gi),
      ...matchAll(ctx.text, /as received on whatsapp/gi),
    ],
  },
  {
    id: 'chain-letter-threat',
    label: 'Threat or pressure to re-forward',
    category: 'manipulation',
    weight: 17,
    why: 'Real news never depends on you forwarding it to a minimum number of people.',
    detect: (ctx) => [
      // "forward", "share" and "send" are the same demand to a reader; a scam
      // that asks for a minimum audience is a chain letter whatever verb it uses.
      ...matchAll(ctx.text, /(?:forward|share|send) (?:this |it |the )?(?:message|post|link|msg)?\s?(?:to|with) (?:at least )?\d{1,4}\s*(?:people|persons|contacts|groups|friends|members)/gi),
      ...matchAll(ctx.text, /(?:forward|share|send) (?:this |it )?(?:message |msg )?(?:to|with) (?:all|everyone|every|both|your (?:family|friends|groups|contacts))/gi),
      ...matchAll(ctx.text, /(?:if|agar) you (?:don'?t|do not|dont) (?:forward|share)/gi),
      ...matchAll(ctx.text, /otherwise (?:you|your (?:family|account|number))[^.\n]{0,40}/gi),
      ...matchAll(ctx.text, /send (?:this )?to (?:all|everyone|10|20|5)/gi),
      ...matchAll(ctx.text, /(?:sabko|sabhi ko|sab logon ko) (?:bhej|forward|share|bhejo)/gi),
      ...matchAll(ctx.text, /\d{1,4}\s*(?:log|logon|logo|people)\s*(?:ko|mein)?\s*(?:bhej|share|forward)/gi),
      ...matchAll(ctx.text, /सबको (?:भेज|फॉरवर्ड|शेयर)/g),
    ],
  },
  {
    id: 'urgency-deletion',
    label: 'Claims it will be deleted or banned soon',
    category: 'manipulation',
    weight: 14,
    why: 'A fake deadline is added so you share before you have time to check.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /will be deleted|being deleted/gi),
      ...matchAll(ctx.text, /before (?:it|this|the message)[^.\n]{0,20}(?:deleted|removed|banned|blocked)/gi),
      ...matchAll(ctx.text, /(?:banned|ban ho|band ho) (?:soon|tomorrow|from tomorrow|tonight|kal)/gi),
      ...matchAll(ctx.text, /(?:share|forward) (?:it )?fast|jaldi (?:share|bhejo)/gi),
      ...matchAll(ctx.text, /(?:delete|band|ban) hone (?:wala|se pehle)/gi),
      ...matchAll(ctx.text, /डिलीट होने|प्रतिबंधित/g),
    ],
  },
  {
    id: 'time-pressure',
    label: 'Artificial time pressure',
    category: 'manipulation',
    weight: 8,
    why: 'Urgency is the single most reliable marker of a manipulated forward.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /today only|only today|last date (?:is )?today|within 24 hours/gi),
      ...matchAll(ctx.text, /(?:expires|ends|closes) (?:tonight|today|in \d+ hours)/gi),
      ...matchAll(ctx.text, /as of today[^.\n]{0,30}(?:banned|changed|stopped)/gi),
      ...matchAll(ctx.text, /aaj hi|aaj hi (?:tak|ke din)|sirf aaj|aaj raat tak|turant|jaldi karo/gi),
      ...matchAll(ctx.text, /आज ही|तुरंत|जल्दी/g),
    ],
  },
  {
    id: 'anonymous-authority',
    label: 'Vague, unverifiable source',
    category: 'provenance',
    weight: 11,
    why: '“My friend works there” and “forwarded as received” cannot be checked by anyone.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /i got this from[^.\n]{0,40}/gi),
      ...matchAll(ctx.text, /my (?:friend|relative|brother|sister|uncle) (?:works|working|is working) (?:at|in|with)[^.\n]{0,40}/gi),
      ...matchAll(ctx.text, /a(?: senior)? (?:officer|official|doctor|journalist) (?:told|said|confirmed)[^.\n]{0,40}/gi),
      ...matchAll(ctx.text, /(?:inside|internal) (?:source|news|information)[^.\n]{0,30}/gi),
      ...matchAll(ctx.text, /(?:kisi ne|mere (?:dost|bhai)) (?:bataya|kaha)[^.\n]{0,30}/gi),
      ...matchAll(ctx.text, /सूत्रों के मुताबिक|सूत्रों ने बताया/g),
    ],
  },

  // ----------------------------------------------------------------- authority
  {
    id: 'fake-platform-policy',
    label: 'Fake WhatsApp / platform policy claim',
    category: 'authority',
    weight: 20,
    why: 'These are the single most recycled forwards on WhatsApp and are almost always false.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /whatsapp (?:is|will be|has|have) (?:now )?(?:charging|going to charge|started charging|become paid|end free)/gi),
      ...matchAll(ctx.text, /whatsapp (?:will|going to) (?:charge|cost|delete|ban)/gi),
      ...matchAll(ctx.text, /(?:pay|charge) (?:rs\.?|₹)?\s?\d+ (?:per|for a) (?:year|month|annum)/gi),
      ...matchAll(ctx.text, /whatsapp (?:privacy|policy|new (?:rule|policy))[^.\n]{0,40}/gi),
      ...matchAll(ctx.text, /(?:whatsapp|facebook|instagram) (?:is )?(?:shutting|closing) down/gi),
    ],
  },
  {
    id: 'vague-government-announcement',
    label: 'Government announcement with no source',
    category: 'authority',
    weight: 11,
    why: 'Actual government schemes are published on official portals, not only inside a forward.',
    detect: (ctx) =>
      ctx.hasNamedOutlet
        ? []
        : [
            ...matchAll(ctx.text, /(?:the )?government (?:has )?(?:announced|decided|approved)[^.\n]{0,50}/gi),
            ...matchAll(ctx.text, /new (?:rule|law|scheme) (?:from|by) (?:the )?(?:govt|government)[^.\n]{0,30}/gi),
            ...matchAll(ctx.text, /(?:prime minister|pm|modi) (?:ji )?(?:has )?(?:announced|declared)[^.\n]{0,40}/gi),
            ...matchAll(ctx.text, /सरकार ने घोषणा|नई योजना/g),
            ...matchAll(ctx.text, /sarkar ne (?:ghoshna|announce)/gi),
          ],
  },
  {
    id: 'pseudoscience-cure',
    label: 'Miracle cure or health misinformation',
    category: 'health',
    weight: 19,
    why: 'Home remedies presented as a cure for serious disease are a mainstay of harmful forward misinformation.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /(?:cure|cures|cured|ilaj|upay) (?:for|of|the) (?:cancer|diabetes|covid|corona|aids|thyroid|asthma|arthritis)/gi),
      ...matchAll(ctx.text, /100%[^.\n]{0,20}(?:cure|effective|safe|guaranteed)/gi),
      ...matchAll(ctx.text, /(?:no side effects|without (?:any )?side effects)/gi),
      ...matchAll(ctx.text, /(?:cancer|corona|covid|diabetes)[^.\n]{0,30}(?:ka ilaj|ka upay)/gi),
      ...matchAll(ctx.text, /(?:kills?|destroys?) (?:the )?(?:virus|corona|covid)[^.\n]{0,25}(?:in \d+|in home|gharelu)/gi),
      ...matchAll(ctx.text, /घरेलू (?:इलाज|नुस्खा)|इलाज (?:है|होता)/g),
    ],
  },
  {
    id: 'vaccine-conspiracy',
    label: 'Anti-vaccine / medical conspiracy claim',
    category: 'health',
    weight: 17,
    why: 'The specific mechanisms claimed (tracking chips, DNA rewriting, infertility) have been repeatedly debunked.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /chip (?:implant|inside|in the vaccine)|microchip[^.\n]{0,20}(?:vaccine|injection)/gi),
      ...matchAll(ctx.text, /(?:changes?|alters?) your dna|modifies (?:your )?dna/gi),
      ...matchAll(ctx.text, /(?:causes?|leads? to) infertility[^.\n]{0,20}(?:vaccine|injection)/gi),
      ...matchAll(ctx.text, /(?:vaccine|vaccination)[^.\n]{0,30}(?:depopulation|kills?|deaths?|dangerous)/gi),
    ],
  },
  {
    id: 'generic-conspiracy',
    label: 'Classic conspiracy framing',
    category: 'authority',
    weight: 16,
    why: 'Conspiracy framing (“they don’t want you to know”) substitutes for evidence.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /(?:they|media|government|doctors?|experts?|scientists?|pharma) (?:don'?t|does not|doesn'?t) want you to know/gi),
      ...matchAll(ctx.text, /(?:mainstream media|msm) (?:won'?t|will not|is hiding|hides)/gi),
      ...matchAll(ctx.text, /(?:big pharma|deep state|new world order|\bnwo\b|agenda 21|agenda 2030)/gi),
      ...matchAll(ctx.text, /(?:hidden|secret|suppressed) (?:truth|agenda|facts?)/gi),
      ...matchAll(ctx.text, /wake up (?:people|sheeple|india|world)/gi),
      ...matchAll(ctx.text, /सच छिपाया|साजिश/g),
    ],
  },

  // --------------------------------------------------------------------- scam
  {
    id: 'prize-or-lottery',
    label: 'Prize, lottery or “you have won” bait',
    category: 'scam',
    weight: 21,
    why: 'Unsolicited winnings that require a click or a fee are a textbook advance-fee scam.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /you (?:have )?won|you are (?:the )?(?:winner|selected)/gi),
      ...matchAll(ctx.text, /(?:lucky|lottery|kbc|bumper) (?:draw|winner|number)/gi),
      ...matchAll(ctx.text, /congratulations[^.\n]{0,40}(?:won|selected|chosen)/gi),
      ...matchAll(ctx.text, /claim your (?:prize|reward|gift|money)/gi),
      ...matchAll(ctx.text, /इनाम|लॉटरी/g),
    ],
  },
  {
    id: 'payment-solicitation',
    label: 'Direct payment or UPI solicitation',
    category: 'scam',
    weight: 20,
    why: 'Legitimate relief funds do not collect money through a forwarded UPI id or a personal phone number.',
    detect: (ctx) => {
      const out = [];
      if (ctx.payment.upiIds.length > 0) out.push(...ctx.payment.upiIds);
      out.push(...matchAll(ctx.text, /(?:upi|paytm|phonepe|gpay|google pay)\s*(?:id|number|:)\s*[^\s,.\n]+/gi));
      out.push(...matchAll(ctx.text, /(?:send|transfer|deposit|pay) (?:rs\.?|inr|₹)?\s?\d[\d,]*/gi));
      out.push(...matchAll(ctx.text, /bank (?:account|a\/c) (?:number|no\.?|details)/gi));
      out.push(...matchAll(ctx.text, /(?:paisa|paise) (?:bhej|transfer)/gi));
      return out;
    },
  },
  {
    id: 'money-for-money-promise',
    label: 'Promises to send back more than you send',
    category: 'scam',
    weight: 22,
    why: 'Money in for more money out is the shape of every advance-fee, "doubling" and fake-investment fraud. The return never arrives.',
    detect: (ctx) => {
      // Money has to be named on both sides of the promise. "Lend me 200" and
      // "give me your number" are ordinary messages; "give me 200 and I will
      // return 400" is the fraud. Requiring an amount in each half is what keeps
      // this signal from firing on normal conversation.
      const ask = matchAll(ctx.text, /(?:give|send|transfer|deposit|pay|invest)\s+(?:me|us)\b[^.\n]{0,40}/gi).filter(mentionsAmount);

      // Typo-tolerant on purpose: forwards are typed fast, and the common
      // misspellings (giv, retun, recieve) are exactly what a regex would miss.
      const promise = ask.length === 0
        ? []
        : matchAll(ctx.text, /\b(?:i|we)\s*(?:will|'ll|shall|can)\s*(?:giv|give|retun|return|pai|pay|credit|doubl|send)\b[^.\n]{0,40}/gi).filter(mentionsAmount);

      // A promised rate of return stands on its own: guaranteeing a specific
      // percentage is a fraud marker whether or not the message also asks for
      // money, which is why these two are not gated behind the ask.
      const rate = matchAll(ctx.text, /\b\d{2,3}\s?%\s*(?:return|profit|guaranteed|daily|monthly)/gi);
      const back = matchAll(ctx.text, /\b(?:money|amount|investment)\s*(?:double|doubled|triple|tripled)\b/gi);

      if (promise.length === 0 && rate.length === 0 && back.length === 0) return [];
      return [...ask, ...promise, ...rate, ...back].slice(0, 4);
    },
  },
  {
    id: 'free-giveaway',
    label: 'Free data / recharge / money offer',
    category: 'scam',
    weight: 18,
    why: '“Free recharge” forwards are typically data-harvesting or premium-SMS traps.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /free (?:data|recharge|internet|wifi|mobile data)/gi),
      ...matchAll(ctx.text, /(?:government|govt|pm) (?:is )?giving (?:free )?(?:data|recharge|money|cash)/gi),
      ...matchAll(ctx.text, /(?:get|claim) (?:rs\.?|₹)?\s?\d[\d,]* (?:free|per month)/gi),
      ...matchAll(ctx.text, /free (?:में )?(?:data|रिचार्ज)/gi),
    ],
  },
  {
    id: 'credential-phishing',
    label: 'Asks for an OTP, PIN or KYC details',
    category: 'scam',
    weight: 22,
    why: 'No bank, telco or government body ever asks for an OTP or PIN over a message.',
    detect: (ctx) => {
      const solicits = [
        ...matchAll(ctx.text, /(?:share|send|tell|provide|give|enter|verify|batao|dalo|daal)\s+(?:me\s+)?(?:your\s+)?(?:otp|pin|cvv|password|atm pin)/gi),
        ...matchAll(ctx.text, /(?:otp|pin|cvv|password)[^.\n]{0,25}\b(?:send|share|enter|provide|batao|dalo|daal|verify)\b/gi),
        ...matchAll(ctx.text, /kyc (?:update|expire|complete|karana|karna|band)[^.\n]{0,40}/gi),
      ];
      if (solicits.length > 0) return solicits;

      // A bare mention is only suspicious when it is not the usual safety advice.
      const bare = ctx.text.match(/\b(?:otp|pin|cvv)\b/gi) ?? [];
      if (bare.length === 0) return [];
      const isSafetyAdvice = /(?:do not|don'?t|never|kabhi|mat)\s+(?:share|give|tell|batao|send|disclose)/i.test(ctx.text);
      return isSafetyAdvice ? [] : bare.slice(0, 3);
    },
  },
  {
    id: 'account-block-threat',
    label: 'Threatens that an account or SIM will be blocked',
    category: 'scam',
    weight: 14,
    why: 'Fear of losing a service is used to push people into acting before they check anything.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /(?:account|sim|number|connection|service)[^.\n]{0,30}(?:will be |get |gets )?(?:blocked|suspended|deactivated|band ho|disconnected)/gi),
      ...matchAll(ctx.text, /(?:blocked|suspended|deactivated) (?:tomorrow|tonight|today)/gi),
    ],
  },
  {
    id: 'clickbait-link',
    label: 'Pressures you to click a link',
    category: 'scam',
    weight: 9,
    why: 'Link-first forwards are distributed for traffic, ad revenue or malware rather than accuracy.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /click (?:here|this link|below|on the link)/gi),
      ...matchAll(ctx.text, /open (?:this )?link[^.\n]{0,20}/gi),
      ...matchAll(ctx.text, /(?:register|apply) (?:now|fast|quickly) (?:at|on|here)/gi),
      ...matchAll(ctx.text, /link par click|link kholo|yahan click/gi),
    ],
  },

  // ------------------------------------------------------------ danger rumours
  {
    id: 'danger-rumour',
    label: 'Unverified danger or threat warning',
    category: 'manipulation',
    weight: 13,
    why: '“Don’t go there today” warnings spread fear and are rarely traceable to any authority.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /(?:will|going to) attack[^.\n]{0,30}/gi),
      ...matchAll(ctx.text, /(?:kidnapping|kidnap) (?:gang|racket|mafia)/gi),
      ...matchAll(ctx.text, /avoid (?:going|travelling|visiting) (?:to )?[^.\n]{0,25}/gi),
      ...matchAll(ctx.text, /don'?t (?:go|travel|visit) (?:to )?[^.\n]{0,25}(?:today|tonight|now)/gi),
      ...matchAll(ctx.text, /(?:not safe|khatarnak|khatra) (?:today|aaj|abhi)/gi),
    ],
  },

  // --------------------------------------------------------------------- style
  {
    id: 'sensational-language',
    label: 'Sensational or clickbait phrasing',
    category: 'style',
    weight: 8,
    why: 'Manipulated messages lean on emotional amplifiers instead of evidence.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /shocking|bombshell|unbelievable|you won'?t believe|mind ?blowing/gi),
      ...matchAll(ctx.text, /breaking news*!+/gi),
      ...matchAll(ctx.text, /(?:viral|exposed|leaked) (?:video|message|photo|chat)/gi),
      ...matchAll(ctx.text, /(?:पर्दाफाश|चौंकाने वाला|धमाकेदार)/g),
    ],
  },
  {
    id: 'caps-shouting',
    label: 'Excessive capitalisation',
    category: 'style',
    weight: 6,
    why: 'Shouting is a stylistic marker of forwarded rumour rather than reporting.',
    detect: (ctx) => {
      if (ctx.words.length < 8 || ctx.capsRatio < 0.28) return [];
      const shouting = ctx.words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w));
      return shouting.slice(0, 4);
    },
  },
  {
    id: 'punctuation-spam',
    label: 'Repeated exclamation / question marks',
    category: 'style',
    weight: 5,
    why: 'Punctuation spam is a low-effort amplifier that factual writing avoids.',
    detect: (ctx) => (ctx.exclamationRuns >= 2 ? matchAll(ctx.text, /[!?]{2,}/g).slice(0, 4) : []),
  },
  {
    id: 'emoji-spam',
    label: 'Emoji-heavy formatting',
    category: 'style',
    weight: 5,
    why: 'Heavy emoji framing is used to make a fabricated message feel official and urgent.',
    detect: (ctx) => (ctx.emojiCount >= 6 ? [`${ctx.emojiCount} emoji in one message`] : []),
  },
  {
    id: 'unsourced-statistic',
    label: 'Precise statistic with no source',
    category: 'style',
    weight: 7,
    why: 'A specific-sounding number borrows credibility from precision while naming nobody who published it.',
    detect: (ctx) => {
      if (ctx.hasNamedOutlet || ctx.urls.length > 0) return [];
      return matchAll(ctx.text, /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent|per cent|percentile|crore|lakh)\b/gi).slice(0, 4);
    },
  },
  {
    id: 'unattributed-quote',
    label: 'Quote attributed to a vague authority',
    category: 'provenance',
    weight: 9,
    why: 'Fabricated quotes are the most common way a false claim gets a respectable face.',
    detect: (ctx) => [
      ...matchAll(
        ctx.text,
        /["“][^"”\n]{25,}["”]\s*[-–—]\s*(?:dr\.?|prof\.?|scientist|doctor|minister|ceo|expert)/gi,
      ),
    ],
  },
  {
    id: 'hidden-characters',
    label: 'Invisible / zero-width characters stripped',
    category: 'manipulation',
    weight: 12,
    why: 'Hidden Unicode characters are used to smuggle a message past platform keyword filters.',
    detect: (ctx) => (ctx.strippedInvisibles ? ['zero-width or bidirectional characters found in the input'] : []),
  },
  {
    id: 'shortener-link',
    label: 'Shortened or redirecting link',
    category: 'scam',
    weight: 8,
    why: 'Shorteners hide the real destination, a common trick in scam forwards.',
    detect: (ctx) => ctx.urls.filter((u) => u.shortened).map((u) => u.raw),
  },
  {
    id: 'audio-image-proof',
    label: 'Presents unverifiable “proof” (voice note / photo)',
    category: 'provenance',
    weight: 7,
    why: 'A voice note or photo with no origin is not evidence, and synthetic media makes it worse.',
    detect: (ctx) => [
      ...matchAll(ctx.text, /(?:voice note|audio (?:message|clip|recording))/gi),
      ...matchAll(ctx.text, /(?:photo|video|picture) (?:as |is )?(?:proof|evidence)/gi),
      ...matchAll(ctx.text, /(?:dekh|sun) lo (?:khud|ye)/gi),
    ],
  },

  // ------------------------------------------------------------- credibility
  {
    id: 'cites-named-outlet',
    label: 'Cites a named news organisation or agency',
    category: 'credibility',
    weight: -9,
    why: 'Attributing a claim to an outlet that actually exists is how verifiable reporting reads.',
    detect: (ctx) => (ctx.hasNamedOutlet ? matchAll(ctx.text, /\b(?:reuters|associated press|ap|bbc|the hindu|indian express|times of india|ndtv|ani|pti|who|cdc|icmr|nasa|unicef|pib)\b/gi).slice(0, 3) : []),
  },
  {
    id: 'authoritative-link',
    label: 'Links to an official or fact-checking domain',
    category: 'credibility',
    weight: -13,
    why: 'A checkable primary source is the strongest sign that a claim can be verified.',
    detect: (ctx) => ctx.urls.filter((u) => u.authoritative).map((u) => u.raw),
  },
  {
    id: 'has-source-link',
    label: 'Includes a source link',
    category: 'credibility',
    weight: -4,
    why: 'Being checkable is itself a mild credibility signal.',
    detect: (ctx) => {
      if (ctx.urls.length === 0) return [];
      if (ctx.urls.every((u) => u.shortened)) return [];
      return ctx.urls.filter((u) => !u.shortened && !u.authoritative).map((u) => u.raw).slice(0, 3);
    },
  },
  {
    id: 'precise-provenance',
    label: 'States a date and a place',
    category: 'credibility',
    weight: -5,
    why: 'Fabricated forwards usually strip the where and the when.',
    detect: (ctx) => {
      const when = matchAll(ctx.text, /\b(?:on|dated|on the)\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi);
      const where = matchAll(ctx.text, /\bin (?:new delhi|mumbai|delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|india|usa|uk|kerala|gujarat|maharashtra|uttar pradesh)\b/gi);
      return when.length > 0 && where.length > 0 ? [...when.slice(0, 2), ...where.slice(0, 2)] : [];
    },
  },
];

function matchAll(text, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const value = match[0].trim();
    if (value.length > 0) out.push(value);
    if (match.index === re.lastIndex) re.lastIndex += 1;
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Run every signal against the text.
 * @param {string} text
 * @returns {{ctx: object, matched: Array, credits: Array, riskScore: number, rawWeight: number, band: object, categories: object}}
 */
export function analyze(text) {
  const ctx = buildContext(text);
  const matched = [];
  const credits = [];

  for (const signal of SIGNALS) {
    let evidence = [];
    try {
      evidence = signal.detect(ctx) ?? [];
    } catch {
      evidence = [];
    }
    if (evidence.length === 0) continue;

    const hit = {
      id: signal.id,
      label: signal.label,
      category: signal.category,
      weight: signal.weight,
      evidence: [...new Set(evidence)].slice(0, 4),
      why: signal.why,
    };
    if (signal.weight >= 0) matched.push(hit);
    else credits.push(hit);
  }

  const rawWeight = [...matched, ...credits].reduce((sum, hit) => sum + hit.weight, 0);
  const riskScore = squash(rawWeight);

  const categories = {};
  for (const hit of matched) {
    categories[hit.category] = (categories[hit.category] ?? 0) + hit.weight;
  }

  return {
    ctx,
    matched,
    credits,
    rawWeight,
    riskScore,
    band: riskBand(riskScore),
    categories,
  };
}

/**
 * Map an unbounded additive weight onto 0-100 with a saturating exponential,
 * score = 100 * (1 - e^(-w/40)).
 *
 * Chosen so the bands mean something in practice: one mild signal stays under
 * the caution threshold, a lone serious signal (a chain-letter threat, a
 * miracle cure) reads as caution, two or three independent serious signals read
 * as elevated, and the genuinely stacked forwards saturate near the top
 * instead of pinning at 100 as soon as the weights add up.
 */
/** Does a snippet name a sum of money? Used to keep two-part signals precise. */
function mentionsAmount(snippet) {
  return /(?:₹|\brs\b|\brsd\b|\brs\.|\binr\b|\brupees?\b|\brupaye\b|\bdollars?\b|\d)/i.test(snippet);
}

export function squash(weight) {
  if (weight <= 0) return 0;
  const score = 100 * (1 - Math.exp(-weight / 40));
  return Math.round(clamp(score, 0, 100));
}

export function riskBand(score) {
  if (score >= 75) return { id: 'high', label: 'high', headline: 'High risk of misinformation' };
  if (score >= 50) return { id: 'elevated', label: 'elevated', headline: 'Elevated risk — several manipulation markers' };
  if (score >= 25) return { id: 'caution', label: 'caution', headline: 'Some warning signs — verify before forwarding' };
  return { id: 'low', label: 'low', headline: 'No strong red flags detected' };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Human-facing name for a red-flag category, used in reports and the UI. */
export const CATEGORY_LABELS = {
  manipulation: 'Manipulation tactics',
  scam: 'Scam indicators',
  health: 'Health misinformation',
  authority: 'Unverifiable authority claims',
  provenance: 'Provenance problems',
  style: 'Writing style',
  credibility: 'Credibility signals',
};

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}

export function categorySummary(categories) {
  return Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .map(([category, weight]) => ({ category, weight }));
}

export { round2 };
