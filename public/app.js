/**
 * ForwardCheck front-end.
 *
 * Everything that comes back from the API is attacker-influenced (it is, after
 * all, a forwarded message), so the renderer builds DOM nodes and sets
 * textContent rather than assembling HTML strings.
 */

const $ = (selector) => document.querySelector(selector);

const els = {
  message: $('#message'),
  verify: $('#verify'),
  clear: $('#clear'),
  counter: $('#counter'),
  samples: $('#samples'),
  output: $('#output'),
  modeLabel: $('#mode-label'),
  modeDot: $('#mode-dot'),
  modelPanel: $('#model-panel'),
  llmProvider: $('#llm-provider'),
  llmModel: $('#llm-model'),
  llmKey: $('#llm-key'),
  llmBaseUrl: $('#llm-baseurl'),
  llmBaseUrlField: $('#llm-baseurl-field'),
  llmRemember: $('#llm-remember'),
  llmKeyLink: $('#llm-keylink'),
  llmNote: $('#llm-note'),
};

const state = { busy: false, lastReport: null, llmPresets: [] };

const LLM_STORE_KEY = 'forwardcheck.llm';

// ---------------------------------------------------------------- bootstrapping

async function boot() {
  els.message.addEventListener('input', updateCounter);
  els.message.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
  });
  els.verify.addEventListener('click', submit);
  els.clear.addEventListener('click', () => {
    els.message.value = '';
    updateCounter();
    renderEmpty();
    els.message.focus();
  });

  setupModelPanel();
  updateCounter();
  await Promise.all([loadHealth(), loadSamples()]);
}

// ------------------------------------------------------------------- BYO LLM

/**
 * Bring-your-own-key reasoning. The key lives in this browser (localStorage
 * only when the person opts in) and is attached to their own requests; the
 * server validates it, uses it once, and never stores it.
 */
function setupModelPanel() {
  const saved = readSavedLlm();

  els.llmProvider.addEventListener('change', () => {
    const preset = state.llmPresets.find((item) => item.id === els.llmProvider.value);
    const isCustom = els.llmProvider.value === 'custom';

    els.llmBaseUrlField.hidden = !isCustom;
    if (preset && !isCustom) {
      els.llmModel.value = preset.model ?? '';
      els.llmKeyLink.href = preset.keyUrl || '#';
      els.llmKeyLink.hidden = !preset.keyUrl;
    } else if (isCustom) {
      els.llmKeyLink.hidden = true;
    } else {
      els.llmKeyLink.hidden = true;
      els.llmModel.value = '';
    }
    persistLlm();
    updateModeLabel();
  });

  for (const field of [els.llmModel, els.llmKey, els.llmBaseUrl]) {
    field.addEventListener('change', persistLlm);
    field.addEventListener('blur', persistLlm);
  }
  els.llmRemember.addEventListener('change', persistLlm);

  if (saved) {
    els.llmRemember.checked = true;
    // Presets fill in once health arrives; stash for then.
    state.pendingLlm = saved;
  }
}

function applySavedLlm() {
  const saved = state.pendingLlm;
  if (!saved) return;
  state.pendingLlm = null;

  if (els.llmProvider.querySelector(`option[value="${CSS.escape(saved.provider)}"]`)) {
    els.llmProvider.value = saved.provider;
    els.llmProvider.dispatchEvent(new Event('change'));
  }
  if (saved.model) els.llmModel.value = saved.model;
  if (saved.baseUrl) els.llmBaseUrl.value = saved.baseUrl;
  if (saved.key) els.llmKey.value = saved.key;
  els.llmBaseUrlField.hidden = saved.provider !== 'custom';
  updateModeLabel();
}

function readSavedLlm() {
  try {
    const raw = localStorage.getItem(LLM_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistLlm() {
  const provider = els.llmProvider.value;
  if (!provider || els.llmKey.value.trim() === '') {
    try { localStorage.removeItem(LLM_STORE_KEY); } catch { /* private mode */ }
    updateModeLabel();
    return;
  }

  const entry = {
    provider,
    model: els.llmModel.value.trim(),
    baseUrl: provider === 'custom' ? els.llmBaseUrl.value.trim() : '',
    // Only the opt-in keeps the key itself; otherwise we remember the shape,
    // not the secret.
    key: els.llmRemember.checked ? els.llmKey.value.trim() : '',
  };

  try {
    if (els.llmRemember.checked) localStorage.setItem(LLM_STORE_KEY, JSON.stringify(entry));
    else localStorage.removeItem(LLM_STORE_KEY);
  } catch { /* private mode: in-memory only */ }
  updateModeLabel();
}

/** The llm block to attach to a verify request, or null for offline. */
function currentLlmConfig() {
  const provider = els.llmProvider.value;
  const apiKey = els.llmKey.value.trim();
  if (!provider || apiKey === '') return null;
  return {
    provider,
    apiKey,
    model: els.llmModel.value.trim() || undefined,
    baseUrl: provider === 'custom' ? els.llmBaseUrl.value.trim() || undefined : undefined,
  };
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    state.serverProviders = health.providers.filter((provider) => provider.configured);

    state.llmPresets = Array.isArray(health.llmPresets) ? health.llmPresets : [];
    for (const preset of state.llmPresets) {
      const option = el('option', { value: preset.id }, preset.label);
      els.llmProvider.append(option);
    }
    applySavedLlm();
    updateModeLabel();
  } catch {
    els.modeDot.className = 'dot error';
    els.modeLabel.textContent = 'Server unreachable';
  }
}

function updateModeLabel() {
  const llm = currentLlmConfig();
  if (llm) {
    const preset = state.llmPresets.find((item) => item.id === llm.provider);
    els.modeDot.className = 'dot live';
    els.modeLabel.textContent = `Your model: ${preset?.label ?? llm.provider} · ${llm.model || 'default'}`;
    els.modeLabel.title = 'Reasoning runs with your own API key. It is sent only with your checks and never stored on the server.';
    els.llmNote.className = 'model-note connected';
    return;
  }

  els.llmNote.className = 'model-note';
  const configured = state.serverProviders ?? [];
  if (configured.length > 0) {
    els.modeDot.className = 'dot live';
    els.modeLabel.textContent = `Enhanced: ${configured.map((provider) => provider.label).join(', ')}`;
    els.modeLabel.title = 'These providers are configured on the server.';
  } else {
    els.modeDot.className = 'dot offline';
    els.modeLabel.textContent = 'Offline mode — heuristic engine only';
    els.modeLabel.title = 'No API keys configured. Add one above to enable fact-check lookups, web evidence and multilingual reasoning.';
  }
}

async function loadSamples() {
  try {
    const response = await fetch('/api/samples');
    const { samples } = await response.json();
    for (const sample of samples) {
      const chip = el('button', { class: 'chip', type: 'button', title: sample.text.slice(0, 160) }, sample.label);
      chip.addEventListener('click', () => {
        els.message.value = sample.text;
        updateCounter();
        submit();
      });
      els.samples.append(chip);
    }
  } catch {
    /* samples are a convenience; ignore */
  }
}

function updateCounter() {
  const length = els.message.value.length;
  els.counter.textContent = `${length.toLocaleString()} character${length === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------- submitting

async function submit() {
  const text = els.message.value.trim();
  if (text.length === 0) {
    els.output.replaceChildren(errorBox('Paste a forwarded message first.'));
    return;
  }
  if (state.busy) return;

  state.busy = true;
  els.verify.disabled = true;
  els.verify.innerHTML = '';
  els.verify.append(el('span', { class: 'spinner' }), document.createTextNode('Verifying…'));
  els.output.replaceChildren(el('p', { class: 'empty-state' }, 'Running the red-flag scan, claim extraction and configured lookups…'));

  const llmConfig = currentLlmConfig();

  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(llmConfig ? { text, llm: llmConfig } : { text }),
    });
    const payload = await response.json();

    if (!response.ok) {
      els.output.replaceChildren(
        errorBox(payload.message ?? payload.error ?? `Request failed with status ${response.status}.`),
      );
      return;
    }

    state.lastReport = payload;
    renderReport(payload);
  } catch (error) {
    els.output.replaceChildren(errorBox(`Could not reach the verifier: ${error.message}`));
  } finally {
    state.busy = false;
    els.verify.disabled = false;
    els.verify.textContent = 'Verify message';
  }
}

// ---------------------------------------------------------------- card accents

/**
 * Maximalist severity ramp.
 *
 * Loud, colour-coded: green is calm, red is critical. Severity is whichever
 * signal is worse — the verdict type or the risk score — so a calm message
 * that is provably false still screams in red, and a heavily flagged but
 * undecided one is never painted green.
 */
const VOLT = ['#00d26a', '#ffc700', '#ff7a00', '#ff2d55'];
const TONE_VOLT = { danger: 3, warn: 2, misleading: 2, neutral: 0, ok: 0 };

function voltFor(verdict) {
  const byRisk = verdict.riskScore >= 70 ? 3 : verdict.riskScore >= 45 ? 2 : verdict.riskScore >= 20 ? 1 : 0;
  const byTone = TONE_VOLT[verdict.tone] ?? 0;
  return VOLT[Math.max(byRisk, byTone)];
}

// --------------------------------------------------------------------- rendering

function renderReport(report) {
  const frag = document.createDocumentFragment();
  frag.append(verdictCard(report));
  frag.append(actionsCard(report));

  if (report.redFlags.length > 0) frag.append(flagsCard('Red flags in this message', report.redFlags, 'flag'));
  if (report.credibilityCredits.length > 0) {
    frag.append(flagsCard('Credibility signals', report.credibilityCredits, 'flag credit'));
  }
  if (report.factChecks.length > 0) frag.append(factChecksCard(report.factChecks));
  if (report.evidence.length > 0) frag.append(evidenceCard(report.evidence));
  if (report.llm) frag.append(llmCard(report.llm));
  if (report.claims.length > 0) frag.append(claimsCard(report.claims));
  frag.append(providersCard(report));
  frag.append(replyCard(report));

  els.output.replaceChildren(frag);

  // The ring is built at --score: 0, then moved to its real value so the
  // registered property sweeps up. A transition only ticks on a page that is
  // actually rendering: in a hidden/backgrounded tab it would leave the arc
  // stuck at 0, so the sweep is opt-in on visible documents only — the score
  // itself is always correct either way. Reduced motion snaps via CSS.
  const rings = els.output.querySelectorAll('.score-ring');
  if (document.visibilityState === 'visible') {
    void els.output.offsetHeight; // commit the starting value first
    for (const node of rings) node.style.setProperty('--score', node.dataset.score ?? '0');
  } else {
    for (const node of rings) {
      node.style.transition = 'none';
      node.style.setProperty('--score', node.dataset.score ?? '0');
    }
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function verdictCard(report) {
  const { verdict } = report;
  const tone = { danger: 'danger', warn: 'warn', neutral: '', ok: 'ok' }[verdict.tone] ?? '';

  const volt = voltFor(verdict);
  // Built at 0 and pushed to the real value after insertion (see renderReport)
  // so the dial sweeps instead of snapping.
  const ring = el('div', {
    class: 'score-ring',
    style: `--score:0;--ring-color:${volt}`,
    'data-score': String(verdict.riskScore),
  },
    el('div', { class: 'score-value' },
      el('strong', {}, String(verdict.riskScore)),
      el('span', {}, 'risk / 100'),
    ),
  );

  const head = el('div', { class: 'verdict-head' },
    el('div', { class: `badge-${tone}` },
      el('p', { class: 'verdict-label' }, `${verdict.title ?? verdict.label} · confidence ${Math.round(verdict.confidence * 100)}%`),
      el('h2', { class: 'verdict-headline' }, verdict.headline),
      el('p', { class: 'verdict-basis' }, verdict.basis),
    ),
    ring,
  );

  const metrics = el('div', { class: 'metrics' },
    metric('Risk band', verdict.riskBand),
    metric('Detected language', report.language.label),
    metric('Mode', report.mode === 'live-enhanced' ? 'Live-enhanced' : 'Offline heuristics'),
    metric('Providers used', `${Object.values(report.providers).filter((p) => p.status === 'ok').length} / ${Object.keys(report.providers).length}`),
    metric('Checked in', `${report.timings.total} ms`),
  );

  return el('section', { class: `verdict-card ${tone}`, style: `--edge:${volt}` }, head, metrics);
}

function metric(label, value) {
  return el('div', { class: 'metric' }, el('strong', {}, String(value)), label);
}

function actionsCard(report) {
  const items = report.recommendedActions.map((action) => el('li', {}, action));
  return el('section', { class: 'card' }, el('h2', {}, 'What to do next'), el('ul', { class: 'plain actions' }, ...items));
}

function flagsCard(title, flags, className) {
  const items = flags.map((flag) =>
    el('li', { class: className },
      el('div', { class: 'flag-top' },
        el('span', { class: 'flag-title' }, flag.label),
        el('span', { class: 'tag' }, flag.categoryLabel ?? flag.category),
      ),
      el('p', { class: 'flag-why' }, flag.why),
      ...flag.evidence.map((quote) => el('code', { class: 'evidence-quote' }, quote)),
    ),
  );
  return el('section', { class: 'card' },
    el('h2', {}, title, el('span', { class: 'count' }, `${flags.length}`)),
    el('ul', { class: 'plain' }, ...items),
  );
}

function claimsCard(claims) {
  const items = claims.map((claim) =>
    el('li', { class: 'claim' },
      el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(claim.checkWorthiness * 100)}%` })),
      el('p', {}, claim.text),
    ),
  );
  return el('section', { class: 'card' },
    el('h2', {}, 'Claims worth checking', el('span', { class: 'count' }, 'ranked by check-worthiness')),
    el('ul', { class: 'plain' }, ...items),
  );
}

function factChecksCard(factChecks) {
  const items = factChecks.map((check) => {
    const row = el('div', { class: 'source' },
      el('div', { class: 'flag-top' },
        el('span', { class: `rating ${check.normalizedRating}` }, check.normalizedRating),
        el('span', { class: 'meta' }, `${check.publisher}${check.reviewDate ? ` · ${check.reviewDate}` : ''}`),
      ),
    );
    if (check.claim) row.append(el('p', { class: 'snippet' }, `Claim reviewed: ${check.claim}`));
    if (check.url) row.append(el('p', {}, el('a', { href: check.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read the fact-check →')));
    return row;
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Published fact-checks of this claim', el('span', { class: 'count' }, `${factChecks.length} match(es)`)),
    el('div', {}, ...items),
  );
}

function evidenceCard(evidence) {
  const items = evidence.map((item) =>
    el('div', { class: 'source' },
      el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title || item.url),
      el('p', { class: 'meta' }, hostOf(item.url) + (item.publishedDate ? ` · ${item.publishedDate.slice(0, 10)}` : '')),
      item.snippet ? el('p', { class: 'snippet' }, item.snippet) : null,
    ),
  );
  return el('section', { class: 'card' },
    el('h2', {}, 'Related sources', el('span', { class: 'count' }, `${evidence.length}`)),
    el('div', {}, ...items),
  );
}

function llmCard(llm) {
  const body = el('div', { class: 'llm-note' },
    el('p', {}, llm.reasoning || 'The model returned no reasoning text.'),
  );

  if (llm.translation && llm.translation.trim() !== '') {
    body.append(el('div', { class: 'translation' }, el('strong', {}, 'Translation: '), llm.translation));
  }
  if (llm.redFlags?.length > 0) {
    body.append(el('div', { class: 'translation' }, el('strong', {}, 'Model-identified manipulation: '), llm.redFlags.join(' · ')));
  }
  if (llm.knownFactCheck?.note) {
    body.append(el('div', { class: 'translation' }, el('strong', {}, 'On existing fact-checks: '), llm.knownFactCheck.note));
  }

  return el('section', { class: 'card' },
    el('h2', {}, 'Model reasoning', el('span', { class: 'count' }, `${llm.model} · language ${llm.language}`)),
    body,
  );
}

function providersCard(report) {
  const chips = Object.entries(report.providers).map(([id, provider]) => {
    const detail = provider.status === 'ok'
      ? (provider.matches !== undefined ? `${provider.matches} match(es)`
        : provider.results !== undefined ? `${provider.results} result(s)`
        : provider.model ?? 'used')
      : provider.reason ?? provider.status;
    return el('div', { class: 'provider', title: detail },
      el('span', { class: `provider-dot ${provider.status}` }),
      el('b', {}, provider.label ?? id),
      el('span', {}, provider.status === 'ok'
        ? `· ${provider.model ?? detail}${provider.via === 'your-key' ? ' (your key)' : ''}`
        : `· ${provider.status}`),
    );
  });

  const card = el('section', { class: 'card' },
    el('h2', {}, 'Evidence sources', el('span', { class: 'count' }, `${Object.values(report.providers).filter((p) => p.status === 'ok').length} contributing`)),
    el('div', { class: 'provider-grid' }, ...chips),
  );

  if (report.queries?.length > 0) {
    card.append(el('p', { class: 'meta', style: 'color:var(--muted);font-size:12.5px;margin:12px 0 0' },
      `Lookup queries: ${report.queries.map((query) => `“${query}”`).join(', ')}`));
  }
  return card;
}

function replyCard(report) {
  const box = el('div', { class: 'reply' }, report.replySuggestion);
  const copy = el('button', { class: 'btn ghost small', type: 'button' }, 'Copy reply');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(report.replySuggestion);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy reply'; }, 1800);
    } catch {
      copy.textContent = 'Select and copy manually';
    }
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Suggested reply to the sender'),
    box,
    el('div', { class: 'reply-bar' }, copy),
  );
}

function renderEmpty() {
  els.output.replaceChildren();
}

function errorBox(message) {
  return el('div', { class: 'error-box' }, message);
}

// ------------------------------------------------------------------- utilities

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'href') node.setAttribute('href', value);
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

boot();
