# ForwardCheck

An automated verifier for fake news and forwarded misinformation. Paste a
forwarded message — the kind that arrives on WhatsApp with `Forwarded many
times` at the top, six emoji, a fake deadline and no source — and get back a
red-flag analysis, the checkable claims inside it, published fact-checks of
those claims, cited web evidence, and a reply you can send back to the person
who forwarded it.

It runs on Cloudflare Workers. **The whole heuristic engine, claim extraction
and scam detection work with no network, no accounts and no API keys.** Keys
upgrade the report; they are never required for it to answer.

```
┌─────────────┐   ┌──────────────────┐   ┌───────────────────────────────┐
│ paste text  │ → │ offline engine   │ → │ optional evidence providers   │
└─────────────┘   │ ・red-flag scan  │   │ ・Google Fact Check Tools     │
                  │ ・claim ranking  │   │ ・Exa web search              │
                  │ ・scam detection │   │ ・LLM reasoning (multilingual) │
                  └──────────────────┘   └───────────────┬───────────────┘
                                                         ↓
                                            ┌────────────────────────────┐
                                            │ verdict fusion             │
                                            │ + actions + reply draft    │
                                            └────────────────────────────┘
```

## The design decision that matters most

**Risk is not proof.** The red-flag score describes the *message* — its
urgency, its missing source, its scare tactics. Style is a strong hint but it
is not evidence, so the engine will never label a message *false* on wording
alone. Precedence is enforced in one place, [`worker/lib/verdict.js`](worker/lib/verdict.js):

1. **A published fact-check match** wins, and carries the highest confidence.
2. **A model verdict** is used next, with confidence adjusted when the model and
   the heuristics disagree.
3. **Heuristics alone** can only ever say *unverified* — with the risk score
   doing the alarming. This is why every sample message, with no keys
   configured, comes back as `unverified` even at risk 93/100.

That ordering is [covered by a test](test/verdict.test.js) asserting that no
bundled sample is ever declared false without external evidence.

## Verdict labels

| Label | Meaning |
| --- | --- |
| `likely-false` | A fact-check review rated the claim false, or the model found it contradicted. |
| `misleading` | Technically true but wrong date, place, image or missing context. |
| `unverified` | Nothing authoritative settled it. **Not** a clean bill of health — read the risk score. |
| `likely-true` | A published review supports the claim. |
| `no-claim` | Nothing checkable in the message. |

Separately, the **risk score (0-100)** rates the message itself:
`< 25` low · `25-49` caution · `50-74` elevated · `≥ 75` high.
The mapping is a saturating exponential (`100 · (1 − e^(−w/40))`) so one mild
signal stays under the caution line while genuinely stacked forwards top out.

## What the offline engine actually detects

Around 25 explainable signals across six categories, each reporting the literal
substring that triggered it. English **and** Hinglish/Devanagari patterns,
because that is what the forwards in this problem space look like.

- **Manipulation** — forward-chain pressure (`forward to 10 people`, `sabko
  bhejo`, `सबको भेज`), fake deadlines (`before it is deleted`, `delete hone
  wala`), artificial urgency, zero-width/bidi characters used to sneak past
  platform filters.
- **Scam** — UPI ids and payment requests, prize/lottery bait, free-recharge
  offers, OTP/PIN/KYC solicitation, "your SIM will be blocked", shortener links.
- **Health** — miracle cures, `100% cure`, anti-vaccine conspiracy mechanisms.
- **Unverifiable authority** — fake WhatsApp policy claims, government
  announcements with no outlet named, generic conspiracy framing.
- **Provenance** — `Forwarded many times`, `I got this from my friend who works
  at…`, unattributed quotes, voice-note-as-proof.
- **Credibility credits** (negative weight) — named outlets, links to `.gov` /
  WHO / fact-checker domains, a stated date *and* place.

The engine deliberately rewards sourced messages: a Reuters-style paragraph with
an `rbi.org.in` link and a date scores **risk 0** and collects three credibility
credits.

## Quick start

```bash
npm install

npm test          # 50 unit + integration tests, no network needed
npm run build     # bundle the Worker and stage the deploy artifacts
npm run dev       # wrangler dev on http://127.0.0.1:8787
```

CLI (same pipeline, no browser):

```bash
node cli.js "Fwd: WhatsApp is going to charge Rs 500 per year!!!"
node cli.js --sample whatsapp-charging
node cli.js --sample hinglish-free-recharge --json
pbpaste | node cli.js
```

`cli.js` reads keys from the environment or from a local `.dev.vars`.

## Turning on the live providers

All providers are optional, independent, and degrade only their own line
in the report when missing — the verdict always comes back, and `providers`
in the response says exactly what contributed.

### 1. LLM reasoning (optional, makes non-English forwards work)

The model does language detection, translation, claim extraction, and
multilingual reasoning. If no key is set, the offline heuristic engine
answers anyway.

| Variable | Provider | What it adds | Cost |
| --- | --- | --- | --- |
| `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL` | Any OpenAI-compatible endpoint | Language detection, translation, claim extraction and reasoning | Your choice |
| `OPENROUTER_FREE` (any non-empty value) | OpenRouter free tier (Inkling Small, 1M context) | LLM reasoning without a per-user key | $0, no credit card |

**Provider presets** in the UI (configured on the server):
`openai`, `groq`, `gemini`, `anthropic`, `mistral`, `deepseek`, `openrouter`
(paid), `openrouter-free` (free tier), `xai`, `together`, `custom` (self-hosted).

The LLM is always called *after* the web lookups so it can reason over the
evidence. `LLM_BASE_URL` defaults to `https://api.openai.com/v1`; any
OpenAI-compatible endpoint works (Groq, Gemini compatibility, OpenLLM
gateway, a local Ollama/LM Studio on localhost).

### 2. Web search + fact-check database (optional)

| Variable | Provider | What it adds | Cost |
| --- | --- | --- | --- |
| `FACTCHECK_API_KEY` | [Google Fact Check Tools](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search) | Real ClaimReview lookups from AFP, BOOM, AltNews, PolitiFact, Snopes… | Free (Google Cloud key) |
| `EXA_API_KEY` | [Exa](https://docs.exa.ai/reference/search) | Live web search with highlights, used as citable context | Free tier available |

### 3. Set up a key

```bash
cp .dev.vars.example .dev.vars   # local dev
# or set the same names as Worker secrets in Cloudflare
```

## Bring-your-own-key (BYOK) — per request

Set a key in the UI model panel and the app will call your LLM with that key
only for your requests. The key is stored in your browser's `localStorage`
ononly when you check "Remember on this device", is never stored on the server,
and is never echoed back in the report.

## Free tier without a key

Enable the free-tier OpenRouter in two steps:

1. Get a key: https://openrouter.ai/settings/keys
2. Use **OpenRouter (Free)** in the UI dropdown, or set `OPENROUTER_FREE` on
   the server (any non-empty value).

Free tier limits: 20 requests/min, 200 requests/day. These reset daily.

## API

```
GET  /api/health   → configured providers, capabilities, limits
GET  /api/samples  → the demo forwards used by the UI
POST /api/verify   → { "text": "...", "useLive": true } → full report
```

`useLive: false` forces the offline path even when keys exist — useful for
tests and for a deterministic result. Requests are capped at 20,000 characters.

## Deploy

```bash
npm run build     # → dist/worker.js, dist/public/, dist/manifest.json
```

Deploy `dist/manifest.json`. The bundle is a single ES module with no imports
and no Node built-ins (the build fails if one sneaks in), and assets are served
through `env.ASSETS.fetch` with SPA fallback.

## Interface

A dark "forensic console" design: near-black chassis (`#0B0C0E`), film grain,
soft ambient light, one acid accent (`#D4FF3F`) and oversized editorial type.
Typography is self-hosted — Space Grotesk for display, JetBrains Mono for data —
so the page never needs the network, which keeps the offline promise true.

Severity is carried by a colour ramp — green → amber → orange → red — on the
verdict card's edge, the risk dial and the headline block. The ramp takes
whichever signal is worse, the verdict type or the risk score, so a calm
message that is provably false still renders red, while a flagged but
undecided one is never painted green.

Nothing depends on colour alone: the label, the headline, the risk band and the
printed score all say the same thing in words, and every text/background pair in
every rendered state clears 4.5:1 contrast against its background.

## Known limitations — read before trusting it

- **The risk score is a linguistic heuristic.** A calm, well-formatted lie
  scores low; a true story written by an excitable relative scores high. It
  describes rhetoric, and the report says so.
- **Offline mode cannot tell you whether a claim is true.** Without a key the
  strongest honest answer is *unverified* plus a risk assessment.
- **The rate limit is per-isolate.** It is [`worker/index.js`](worker/index.js)
  state, so it bounds casual abuse, not a determined attacker. Put Cloudflare's
  own rate limiting in front of it for real traffic.
- **`normalizeRating` is a string mapper, not a semantic one.** It handles the
  ratings common fact-checkers publish; an unusual one lands in `unknown`
  rather than being guessed.
- **Claim extraction is rule-based.** The LLM step does this far better; the
  offline extractor exists so the tool still works signed-out and offline.
- **The URL patterns run over text, not the rendered DOM.** A scam link hidden
  behind a link preview is only caught by its host.
- **Free tier is rate-limited** (20 req/min, 200 req/day). Do not use it for
  high-volume checks — use a paid provider or the on-premises heuristic engine
  for unlimited calls.

ForwardCheck is an aid, not an authority. It can miss context and it can be
wrong — the report links its sources so they can be checked directly.
# Automated-fake-news-and-forwarded-misinformation-verifiers
