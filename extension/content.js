(function () {
  'use strict';

  if (window.__truvalaLoaded) return;
  window.__truvalaLoaded = true;

  const BACKEND_URL = 'http://localhost:8000/analyze';

  // ─── Preferences state ────────────────────────────────────────────────────────

  const currentPrefs = {
    max_price:          { value: 1000000, importance: 5 },
    min_bedrooms:       { value: 2,       importance: 4 },
    min_bathrooms:      { value: 2,       importance: 3 },
    property_type:      { value: 'single_family', importance: 4 },
    max_distance_miles: { value: 10,      importance: 2 },
    floors:             { value: 'any',   importance: 2 },
    schools:            { value: 8,       importance: 1, mode: 'minimum_rating' },
  };

  // ─── Report state ─────────────────────────────────────────────────────────────

  let currentReport  = null;
  let currentAddress = '';

  // ─── Integration points ──────────────────────────────────────────────────────

  function scrapeListingPage() {
    const visibleText = document.body.innerText;
    return {
      url: window.location.href,
      page_title: document.title,
      visible_text: visibleText.length > 14000 ? visibleText.slice(0, 14000) : visibleText,
      scraped_at: new Date().toISOString(),
      meta: Object.fromEntries(
        Array.from(document.querySelectorAll('meta'))
          .map((tag) => [
            tag.getAttribute('property') || tag.getAttribute('name'),
            tag.getAttribute('content'),
          ])
          .filter(([key, value]) => key && value)
      ),
    };
  }

  function loadUserPreferences() {
    return JSON.parse(JSON.stringify(currentPrefs));
  }

  async function generateListingReport(listingData, preferences) {
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing: listingData, preferences }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Backend error ${res.status}: ${err}`);
    }
    return res.json();
  }

  // ─── State ───────────────────────────────────────────────────────────────────
  // idle | prefs | loading | panel | minimized | editing

  let state = 'idle';

  function setState(next) {
    state = next;

    const fab      = document.getElementById('truvala-fab');
    const bubble   = document.getElementById('truvala-bubble');
    const panel    = document.getElementById('truvala-panel');
    const backdrop = document.getElementById('truvala-backdrop');
    const mini     = document.getElementById('truvala-mini');
    const prefs    = document.getElementById('truvala-prefs');
    const loading  = document.getElementById('truvala-loading');

    const inBubble = state === 'prefs' || state === 'loading' || state === 'editing';

    fab.classList.toggle('truvala-hidden', inBubble);
    bubble.classList.toggle('truvala-visible', inBubble);
    panel.classList.toggle('truvala-visible', state === 'panel');
    backdrop.classList.toggle('truvala-visible', state === 'panel');
    mini.classList.toggle('truvala-visible', state === 'minimized');

    // FAB icon: sliders when report exists and FAB is the way back to prefs
    const reportExists = currentReport !== null;
    fab.innerHTML = (reportExists && state !== 'idle')
      ? ICON_SLIDERS
      : ICON_HOME;

    if (state === 'prefs' || state === 'editing') {
      prefs.style.display = '';
      loading.style.display = 'none';
      renderPrefs();
    }
    if (state === 'loading') {
      prefs.style.display = 'none';
      loading.style.display = '';
    }
  }

  function storeReport(report, address) {
    currentReport  = report;
    currentAddress = address;

    // Keep mini bubble up to date
    const miniScore   = document.getElementById('truvala-mini-score');
    const miniAddress = document.getElementById('truvala-mini-address');
    miniScore.textContent  = report.score;
    miniScore.style.color  = scoreColor(report.score);
    miniAddress.textContent = address;

    // Populate panel
    document.getElementById('truvala-address').textContent = address;
    document.getElementById('truvala-panel-body').innerHTML = buildReportHTML(report);

    setState('panel');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function formatPrice(v) {
    if (v >= 1000000) return `$${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1)}M`;
    return `$${Math.round(v / 1000)}k`;
  }

  function impToLevel(importance) {
    if (importance >= 4) return 'high';
    if (importance >= 3) return 'med';
    return 'low';
  }

  function levelToImp(level) {
    return { low: 2, med: 3, high: 5 }[level] ?? 3;
  }

  function scoreColor(score) {
    if (score >= 80) return '#10b981';
    if (score >= 60) return '#f59e0b';
    return '#ef4444';
  }

  function riskClass(risk) {
    const r = (risk || '').toLowerCase();
    if (r.includes('low') && !r.includes('high')) return 'risk-low';
    if (r.includes('high')) return 'risk-high';
    return 'risk-medium';
  }

  function fieldBarColor(utility) {
    if (utility >= 0.8) return '#10b981';
    if (utility >= 0.5) return '#f59e0b';
    return '#ef4444';
  }

  function getPageAddress() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.split('|')[0].trim();
    return document.title.split('|')[0].trim();
  }

  // ─── Preferences form ─────────────────────────────────────────────────────────

  function impGroup(prefKey) {
    const level = impToLevel(currentPrefs[prefKey].importance);
    return `
      <div class="truvala-imp-row">
        <span class="truvala-imp-label">Importance</span>
        <div class="truvala-imp-group" data-pref="${prefKey}">
          <button class="truvala-imp-btn${level === 'low'  ? ' truvala-imp-active' : ''}" data-level="low">Low</button>
          <button class="truvala-imp-btn${level === 'med'  ? ' truvala-imp-active' : ''}" data-level="med">Med</button>
          <button class="truvala-imp-btn${level === 'high' ? ' truvala-imp-active' : ''}" data-level="high">High</button>
        </div>
      </div>`;
  }

  function sliderInputField({ id, prefKey, label, sliderMin, sliderMax, step, format }) {
    const val = currentPrefs[prefKey].value;
    return `
      <div class="truvala-pref-row">
        <div class="truvala-pref-header">
          <span class="truvala-pref-name">${label}</span>
          <input class="truvala-text-input" id="truvala-input-${id}"
            type="text" value="${format(val)}" autocomplete="off" spellcheck="false">
        </div>
        <input class="truvala-slider" type="range" id="truvala-slider-${id}"
          min="${sliderMin}" max="${sliderMax}" step="${step}"
          value="${Math.min(Math.max(val, sliderMin), sliderMax)}">
        ${impGroup(prefKey)}
      </div>`;
  }

  function pillField({ prefKey, label, options }) {
    const current = currentPrefs[prefKey].value;
    const pills = options.map(({ value, label: lbl }) => `
      <button class="truvala-pill${value == current ? ' truvala-pill-active' : ''}"
        data-pref="${prefKey}" data-value="${value}">${lbl}</button>`).join('');
    return `
      <div class="truvala-pref-row">
        <div class="truvala-pref-header">
          <span class="truvala-pref-name">${label}</span>
        </div>
        <div class="truvala-pill-group">${pills}</div>
        ${impGroup(prefKey)}
      </div>`;
  }

  function buildPrefsHTML() {
    const schoolsOff = currentPrefs.schools.mode === 'not_important';
    const schoolVal  = currentPrefs.schools.value;
    const isEditing  = state === 'editing';

    return `
      ${sliderInputField({
        id: 'price', prefKey: 'max_price', label: 'Max Price',
        sliderMin: 400000, sliderMax: 5000000, step: 25000, format: formatPrice,
      })}

      ${pillField({
        prefKey: 'min_bedrooms', label: 'Bedrooms',
        options: [
          { value: 1, label: '1' }, { value: 2, label: '2' },
          { value: 3, label: '3' }, { value: 4, label: '4' }, { value: 5, label: '5+' },
        ],
      })}

      ${pillField({
        prefKey: 'min_bathrooms', label: 'Bathrooms',
        options: [
          { value: 1, label: '1' }, { value: 1.5, label: '1.5' },
          { value: 2, label: '2' }, { value: 2.5, label: '2.5' }, { value: 3, label: '3+' },
        ],
      })}

      ${pillField({
        prefKey: 'property_type', label: 'Property Type',
        options: [
          { value: 'single_family', label: 'Single Family' },
          { value: 'townhouse', label: 'Townhouse' },
          { value: 'condo', label: 'Condo' },
          { value: 'any', label: 'Any' },
        ],
      })}

      ${sliderInputField({
        id: 'distance', prefKey: 'max_distance_miles', label: 'Max Distance',
        sliderMin: 1, sliderMax: 30, step: 1, format: (v) => `${v} mi`,
      })}

      ${pillField({
        prefKey: 'floors', label: 'Floors',
        options: [
          { value: 'single_story', label: '1-story' },
          { value: 'two_story', label: '2-story' },
          { value: 'three_plus_story', label: '3+ story' },
          { value: 'any', label: 'Any' },
        ],
      })}

      <div class="truvala-pref-row">
        <div class="truvala-pref-header">
          <span class="truvala-pref-name">School Rating</span>
          <span class="truvala-pref-val" id="truvala-val-schools">${schoolsOff ? '—' : `≥ ${schoolVal}`}</span>
        </div>
        <input class="truvala-slider" type="range" id="truvala-slider-schools"
          min="1" max="10" step="1" value="${schoolVal}" ${schoolsOff ? 'disabled' : ''}>
        <label class="truvala-toggle-row">
          <input type="checkbox" id="truvala-schools-toggle" ${schoolsOff ? 'checked' : ''}>
          <span class="truvala-toggle-label">Not important</span>
        </label>
        ${impGroup('schools')}
      </div>

      <div class="truvala-action-row">
        <button class="truvala-btn-yes" id="truvala-analyze">Analyze listing</button>
        ${isEditing ? `<button class="truvala-btn-back" id="truvala-back">Back to report</button>` : ''}
      </div>`;
  }

  // ─── SVG icons ───────────────────────────────────────────────────────────────

  const ICON_HOME = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
      <path d="M9 21V12h6v9"/>
    </svg>`;

  const ICON_SLIDERS = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white"
      stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>
    </svg>`;

  const ICON_CLOSE = `
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

  // ─── Score ring ───────────────────────────────────────────────────────────────

  function buildScoreRing(score) {
    const color = scoreColor(score);
    const r = 15, circ = 2 * Math.PI * r;
    const dash = ((score / 100) * circ).toFixed(2);
    const gap  = (circ - parseFloat(dash)).toFixed(2);
    return `
      <svg width="80" height="80" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="2.5"/>
        <circle cx="18" cy="18" r="${r}" fill="none"
          stroke="${color}" stroke-width="2.5" stroke-linecap="round"
          stroke-dasharray="${dash} ${gap}" transform="rotate(-90 18 18)"/>
        <text x="18" y="17" font-family="-apple-system,sans-serif" font-size="10" font-weight="700"
          fill="${color}" text-anchor="middle" dominant-baseline="middle">${score}</text>
        <text x="18" y="24" font-family="-apple-system,sans-serif" font-size="4"
          fill="#94a3b8" text-anchor="middle" dominant-baseline="middle">/ 100</text>
      </svg>`;
  }

  // ─── Report HTML ──────────────────────────────────────────────────────────────

  function buildReportHTML(report) {
    const listItems = (items, dotClass, symbol) =>
      items.map((text) => `
        <li class="truvala-list-item">
          <span class="truvala-list-dot ${dotClass}">${symbol}</span>
          <span>${text}</span>
        </li>`).join('');

    const fieldChips = Object.values(report.field_scores).map((f) => {
      const pct = Math.round(f.utility * 100);
      return `
        <div class="truvala-field-chip">
          <div class="truvala-field-name">${f.label}</div>
          <div class="truvala-field-bar-track">
            <div class="truvala-field-bar-fill" style="width:${pct}%;background:${fieldBarColor(f.utility)}"></div>
          </div>
          <div class="truvala-field-explanation">${f.explanation}</div>
        </div>`;
    }).join('');

    return `
      <div class="truvala-score-section">
        <div class="truvala-score-ring-wrap">${buildScoreRing(report.score)}</div>
        <div class="truvala-score-meta">
          <div class="truvala-score-label">Buyer Fit Score</div>
          <div class="truvala-score-value" style="color:${scoreColor(report.score)}">${report.score}</div>
          <span class="truvala-risk-badge ${riskClass(report.risk)}">${report.risk} risk</span>
          <div class="truvala-capex-row">Est. capex: <strong>${report.capex_estimate}</strong></div>
        </div>
      </div>
      <div class="truvala-card">
        <div class="truvala-card-title">Summary</div>
        <p class="truvala-summary-text">${report.summary}</p>
      </div>
      <div class="truvala-card">
        <div class="truvala-card-title">Warnings</div>
        <ul class="truvala-list">${listItems(report.warnings, 'warning', '!')}</ul>
      </div>
      <div class="truvala-card">
        <div class="truvala-card-title">What works for you</div>
        <ul class="truvala-list">${listItems(report.positives, 'positive', '✓')}</ul>
      </div>
      <div class="truvala-card">
        <div class="truvala-card-title">Ask before you tour</div>
        <ul class="truvala-list">${listItems(report.questions, 'question', '?')}</ul>
      </div>
      <div class="truvala-card">
        <div class="truvala-card-title">Preference Breakdown</div>
        <div class="truvala-fields-grid">${fieldChips}</div>
      </div>`;
  }

  // ─── DOM ──────────────────────────────────────────────────────────────────────

  function buildDOM() {
    const root = document.createElement('div');
    root.id = 'truvala-root';
    root.innerHTML = `
      <button id="truvala-fab" aria-label="Open Truvala">${ICON_HOME}</button>

      <div id="truvala-mini" role="button" aria-label="Reopen Truvala report">
        <div class="truvala-mini-score" id="truvala-mini-score">—</div>
        <div class="truvala-mini-info">
          <div class="truvala-mini-label">Buyer Fit</div>
          <div class="truvala-mini-address" id="truvala-mini-address"></div>
        </div>
        <div class="truvala-mini-chevron">›</div>
      </div>

      <div id="truvala-bubble" role="dialog" aria-label="Truvala preferences">
        <div class="truvala-bubble-header">
          <span class="truvala-brand">Truvala</span>
          <button class="truvala-icon-close" id="truvala-bubble-close" aria-label="Close">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="truvala-bubble-body">
          <div id="truvala-prefs"></div>
          <div id="truvala-loading" style="display:none">
            <div class="truvala-loading-state">
              <div class="truvala-spinner"></div>
              <p class="truvala-loading-text">Analyzing listing…</p>
              <p class="truvala-loading-sub">Extracting · Scoring · Generating report</p>
            </div>
          </div>
        </div>
      </div>

      <div id="truvala-panel" role="complementary" aria-label="Truvala listing report">
        <div class="truvala-panel-header">
          <div class="truvala-panel-branding">
            <div class="truvala-panel-logo">Truvala</div>
            <div class="truvala-panel-address" id="truvala-address"></div>
          </div>
          <button class="truvala-panel-close" id="truvala-panel-close" aria-label="Close report">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="truvala-panel-body" id="truvala-panel-body"></div>
        <div class="truvala-panel-footer">
          <p class="truvala-footer-note">Demo · Truvala AI homebuying assistant</p>
        </div>
      </div>

      <div id="truvala-backdrop"></div>`;

    document.body.appendChild(root);
    renderPrefs();
  }

  function renderPrefs() {
    document.getElementById('truvala-prefs').innerHTML = buildPrefsHTML();
    bindPrefControls();
  }

  // ─── Events ───────────────────────────────────────────────────────────────────

  function bindEvents() {
    document.getElementById('truvala-fab').addEventListener('click', () => {
      if (state === 'idle')      setState('prefs');
      if (state === 'panel')     setState('editing');
      if (state === 'minimized') setState('editing');
    });

    // Mini bubble reopens the panel
    document.getElementById('truvala-mini').addEventListener('click', () => {
      setState('panel');
    });

    // Bubble close: if editing go back to minimized, else go idle
    document.getElementById('truvala-bubble-close').addEventListener('click', () => {
      setState(currentReport ? 'minimized' : 'idle');
    });

    // Backdrop click: minimize (don't destroy the report)
    document.getElementById('truvala-backdrop').addEventListener('click', () => {
      setState('minimized');
    });

    // Panel close: minimize
    document.getElementById('truvala-panel-close').addEventListener('click', () => {
      setState('minimized');
    });

    // Analyze button (delegated — button is re-rendered on each prefs render)
    document.getElementById('truvala-bubble').addEventListener('click', async (e) => {
      if (e.target.id === 'truvala-back') {
        setState('panel');
        return;
      }
      if (e.target.id !== 'truvala-analyze') return;

      setState('loading');
      try {
        const listingData = scrapeListingPage();
        const preferences = loadUserPreferences();
        const report      = await generateListingReport(listingData, preferences);
        storeReport(report, getPageAddress());
      } catch (err) {
        console.error('[Truvala] Analysis failed:', err);
        setState(currentReport ? 'editing' : 'prefs');
      }
    });
  }

  function bindPrefControls() {
    // Price
    const priceSlider = document.getElementById('truvala-slider-price');
    const priceInput  = document.getElementById('truvala-input-price');
    priceSlider.addEventListener('input', () => {
      currentPrefs.max_price.value = Number(priceSlider.value);
      priceInput.value = formatPrice(currentPrefs.max_price.value);
    });
    priceInput.addEventListener('focus', () => { priceInput.value = String(currentPrefs.max_price.value); priceInput.select(); });
    priceInput.addEventListener('blur', () => {
      const raw = priceInput.value.trim().replace(/[$,\s]/g, '');
      const n = /k$/i.test(raw) ? parseFloat(raw) * 1000
              : /m$/i.test(raw) ? parseFloat(raw) * 1000000
              : parseFloat(raw);
      if (!isNaN(n) && n > 0) currentPrefs.max_price.value = Math.round(n);
      priceSlider.value = Math.min(currentPrefs.max_price.value, Number(priceSlider.max));
      priceInput.value = formatPrice(currentPrefs.max_price.value);
    });
    priceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') priceInput.blur(); });

    // Distance
    const distSlider = document.getElementById('truvala-slider-distance');
    const distInput  = document.getElementById('truvala-input-distance');
    distSlider.addEventListener('input', () => {
      currentPrefs.max_distance_miles.value = Number(distSlider.value);
      distInput.value = `${distSlider.value} mi`;
    });
    distInput.addEventListener('focus', () => { distInput.value = String(currentPrefs.max_distance_miles.value); distInput.select(); });
    distInput.addEventListener('blur', () => {
      const n = parseFloat(distInput.value.replace(/[^0-9.]/g, ''));
      if (!isNaN(n) && n > 0) currentPrefs.max_distance_miles.value = Math.round(n);
      distSlider.value = Math.min(currentPrefs.max_distance_miles.value, Number(distSlider.max));
      distInput.value = `${currentPrefs.max_distance_miles.value} mi`;
    });
    distInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') distInput.blur(); });

    // Schools slider
    const schoolSlider = document.getElementById('truvala-slider-schools');
    schoolSlider.addEventListener('input', () => {
      currentPrefs.schools.value = Number(schoolSlider.value);
      document.getElementById('truvala-val-schools').textContent = `≥ ${schoolSlider.value}`;
    });
    document.getElementById('truvala-schools-toggle').addEventListener('change', (e) => {
      currentPrefs.schools.mode = e.target.checked ? 'not_important' : 'minimum_rating';
      schoolSlider.disabled = e.target.checked;
      document.getElementById('truvala-val-schools').textContent = e.target.checked ? '—' : `≥ ${schoolSlider.value}`;
    });

    // Pill buttons
    const prefsEl = document.getElementById('truvala-prefs');
    prefsEl.addEventListener('click', (e) => {
      const pill = e.target.closest('.truvala-pill');
      if (pill) {
        currentPrefs[pill.dataset.pref].value = isNaN(Number(pill.dataset.value))
          ? pill.dataset.value
          : Number(pill.dataset.value);
        pill.closest('.truvala-pill-group').querySelectorAll('.truvala-pill').forEach((p) => {
          p.classList.toggle('truvala-pill-active', p === pill);
        });
      }
      const imp = e.target.closest('.truvala-imp-btn');
      if (imp) {
        const group = imp.closest('.truvala-imp-group');
        currentPrefs[group.dataset.pref].importance = levelToImp(imp.dataset.level);
        group.querySelectorAll('.truvala-imp-btn').forEach((b) => {
          b.classList.toggle('truvala-imp-active', b === imp);
        });
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    buildDOM();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
