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
    reference_city:     '',
    floors:             { value: 'any',   importance: 2 },
    schools:            { value: 8,       importance: 1, mode: 'minimum_rating' },
  };

  // ─── Report state ─────────────────────────────────────────────────────────────

  let currentReport     = null;
  let currentAddress    = '';
  let currentScreenshot = null;

  // ─── Chat state ───────────────────────────────────────────────────────────────

  let chatMessages    = [];   // [{role, content}] full history sent to backend
  let riskDrawerBuilt = false; // prevents rebuilding DOM on re-open

  // ─── Pinned homes state ───────────────────────────────────────────────────────

  let pinnedHomes          = [];  // [{id, address, url, report}] persisted to chrome.storage.local
  let folderOpen           = false;
  let compareChatMessages  = [];

  // ─── Integration points ──────────────────────────────────────────────────────

  function scrapeListingPage() {
    const fullText = document.body.innerText;
    let visibleText = fullText.slice(0, 25000);

    // School sections often appear late in the page (after similar homes, neighborhood data, etc.)
    // If the school section falls past the 25000-char cutoff, splice it in explicitly.
    if (fullText.length > 25000) {
      const schoolMarkers = ['GreatSchools', 'Assigned Schools'];
      for (const marker of schoolMarkers) {
        const idx = fullText.indexOf(marker);
        if (idx > 20000) {
          visibleText = fullText.slice(0, 20000)
            + '\n\n'
            + fullText.slice(Math.max(0, idx - 300), Math.min(idx + 3000, fullText.length));
          break;
        }
      }
    }

    return {
      url: window.location.href,
      page_title: document.title,
      visible_text: visibleText,
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

  // ─── City autocomplete ────────────────────────────────────────────────────────

  async function fetchCitySuggestions(query) {
    try {
      const url = new URL('https://photon.komoot.io/api/');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '8');
      url.searchParams.set('lang', 'en');
      const resp = await fetch(url.toString());
      if (!resp.ok) return [];
      const data = await resp.json();
      const CITY_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'quarter']);
      const seen = new Set();
      return (data.features || [])
        .filter(f => {
          const p = f.properties || {};
          return p.countrycode === 'US' && CITY_TYPES.has(p.osm_value);
        })
        .map(f => {
          const p = f.properties || {};
          const city  = p.name || '';
          const state = p.state || '';
          return [city, state].filter(Boolean).join(', ');
        })
        .filter(label => { if (seen.has(label)) return false; seen.add(label); return true; });
    } catch {
      return [];
    }
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

    const pinBtn = document.getElementById('truvala-pin-btn');
    if (pinBtn) {
      const showPin = currentReport !== null && (state === 'panel' || state === 'minimized');
      pinBtn.classList.toggle('truvala-hidden', !showPin);
    }

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

  function storeReport(report, address, screenshot = null) {
    currentReport     = report;
    currentAddress    = address;
    currentScreenshot = screenshot;
    chatMessages      = [];
    riskDrawerBuilt   = false;

    // Keep mini bubble up to date
    const miniScore   = document.getElementById('truvala-mini-score');
    const miniAddress = document.getElementById('truvala-mini-address');
    miniScore.textContent   = report.score;
    miniScore.style.color   = scoreColor(report.score);
    miniAddress.textContent = address;

    // Populate panel
    document.getElementById('truvala-address').textContent = address;
    const panelBody = document.getElementById('truvala-panel-body');
    panelBody.innerHTML = buildReportHTML(report);
    panelBody.scrollTop = 0;

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

  function scoreTier(score) {
    if (score >= 75) return { label: 'Strong Match',   color: '#10b981' };
    if (score >= 50) return { label: 'Moderate Match', color: '#f59e0b' };
    return             { label: 'Weak Match',     color: '#ef4444' };
  }

  // keyMap shared by prefs form and score summary
  const FIELD_PREF_MAP = {
    price: 'max_price', bedrooms: 'min_bedrooms', bathrooms: 'min_bathrooms',
    property_type: 'property_type', distance: 'max_distance_miles',
    floors: 'floors', schools: 'schools',
  };

  function buildScoreSummaryLine(fieldScores) {
    const fields = Object.entries(fieldScores).map(([key, f]) => {
      const prefKey    = FIELD_PREF_MAP[key];
      const importance = prefKey ? (currentPrefs[prefKey]?.importance ?? 3) : 3;
      const utility    = f.utility ?? 0.5;
      return {
        label:     f.label,
        utility,
        winScore:  utility * importance,
        dragScore: (1 - utility) * importance,
      };
    });

    const wins = fields
      .filter(f => f.utility >= 0.75)
      .sort((a, b) => b.winScore - a.winScore)
      .slice(0, 2)
      .map(f => f.label.toLowerCase());

    const drags = fields
      .filter(f => f.utility <= 0.35)
      .sort((a, b) => b.dragScore - a.dragScore)
      .slice(0, 2)
      .map(f => f.label.toLowerCase());

    const join = arr => arr.length === 1 ? arr[0] : `${arr[0]} and ${arr[1]}`;

    if (wins.length && drags.length) {
      return `Strong on ${join(wins)} — ${join(drags)} ${drags.length === 1 ? 'is' : 'are'} a concern`;
    }
    if (wins.length) {
      const allWins = fields.filter(f => f.utility >= 0.75).length;
      return allWins >= Math.ceil(fields.length * 0.6)
        ? 'Fits well across most criteria'
        : `Strong match on ${join(wins)}`;
    }
    if (drags.length) {
      return `${join(drags)} ${drags.length === 1 ? 'is' : 'are'} a concern`;
    }
    return 'Mixed fit — review the breakdown';
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

  function formatPrefValue(fieldKey) {
    const keyMap = {
      price: 'max_price', bedrooms: 'min_bedrooms', bathrooms: 'min_bathrooms',
      property_type: 'property_type', distance: 'max_distance_miles',
      floors: 'floors', schools: 'schools',
    };
    const p = currentPrefs[keyMap[fieldKey]];
    if (!p) return null;
    switch (fieldKey) {
      case 'price':         return `Max ${formatPrice(p.value)}`;
      case 'bedrooms':      return `Min ${p.value} bed${p.value !== 1 ? 's' : ''}`;
      case 'bathrooms':     return `Min ${p.value} bath${p.value !== 1 ? 's' : ''}`;
      case 'distance':      return `Within ${p.value} mi`;
      case 'property_type': return ({ single_family: 'Single family', townhouse: 'Townhouse', condo: 'Condo', any: 'Any type' })[p.value] ?? p.value;
      case 'floors':        return ({ single_story: 'Single story', two_story: 'Two story', three_plus_story: '3+ story', any: 'Any' })[p.value] ?? p.value;
      case 'schools':       return p.mode === 'not_important' ? 'Not important' : `Min rating ${p.value}/10`;
      default:              return null;
    }
  }

  function getPrefImportance(fieldKey) {
    const keyMap = {
      price: 'max_price', bedrooms: 'min_bedrooms', bathrooms: 'min_bathrooms',
      property_type: 'property_type', distance: 'max_distance_miles',
      floors: 'floors', schools: 'schools',
    };
    return currentPrefs[keyMap[fieldKey]]?.importance ?? null;
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

      <div class="truvala-pref-row">
        <div class="truvala-pref-header">
          <span class="truvala-pref-name">Max Distance</span>
          <input class="truvala-text-input" id="truvala-input-distance"
            type="text" value="${currentPrefs.max_distance_miles.value} mi" autocomplete="off" spellcheck="false">
        </div>
        <input class="truvala-slider" type="range" id="truvala-slider-distance"
          min="1" max="30" step="1"
          value="${Math.min(Math.max(currentPrefs.max_distance_miles.value, 1), 30)}">
        <div class="truvala-ref-city-row">
          <span class="truvala-ref-city-label">from</span>
          <input class="truvala-ref-city-input" id="truvala-input-ref-city"
            type="text" placeholder="e.g. Newport Beach, CA"
            value="${currentPrefs.reference_city || ''}" autocomplete="off" spellcheck="false">
        </div>
        ${impGroup('max_distance_miles')}
      </div>

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

  const ICON_PIN = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="17" x2="12" y2="22"/>
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
    </svg>`;

  const ICON_FOLDER = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>`;

  // ─── Cost breakdown HTML ─────────────────────────────────────────────────────

  function fmt(n) {
    return '$' + Math.round(n).toLocaleString();
  }

  function costRow(label, value, cls = '', note = '') {
    return `
      <div class="truvala-cost-row ${cls}">
        <span class="truvala-cost-label">${label}</span>
        <span class="truvala-cost-value">${value}</span>
      </div>
      ${note ? `<div class="truvala-cost-note">${note}</div>` : ''}`;
  }

  function buildSavingsChart(ecosolar) {
    const { panel_monthly_payment, monthly_electric_savings, estimated_payoff_years } = ecosolar;
    const MONTHS = 240;
    const payoffM = Math.round((estimated_payoff_years || 0) * 12);
    const duringRate = monthly_electric_savings - panel_monthly_payment;
    const afterRate  = monthly_electric_savings;

    const savingsAt = m => m <= payoffM
      ? m * duringRate
      : payoffM * duringRate + (m - payoffM) * afterRate;

    const maxVal = savingsAt(MONTHS);
    if (maxVal <= 0) return '';

    const W = 296, H = 130;
    const PL = 36, PR = 8, PT = 18, PB = 20;
    const cW = W - PL - PR, cH = H - PT - PB;
    const sx = m => PL + (m / MONTHS) * cW;
    const sy = v => PT + cH - (Math.max(0, v) / maxVal) * cH;

    const pts = [];
    for (let m = 0; m <= MONTHS; m += 4) {
      if (pts.length && pts[pts.length - 1] < payoffM && m > payoffM) pts.push(payoffM);
      pts.push(m);
    }
    const line = pts.map((m, i) => `${i === 0 ? 'M' : 'L'}${sx(m).toFixed(1)},${sy(savingsAt(m)).toFixed(1)}`).join(' ');
    const area = `${line} L${sx(MONTHS).toFixed(1)},${sy(0).toFixed(1)} L${sx(0).toFixed(1)},${sy(0).toFixed(1)}Z`;
    const px = sx(payoffM).toFixed(1);

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible;margin:0 auto">
      <path d="${area}" fill="rgba(16,185,129,0.12)"/>
      <path d="${line}" fill="none" stroke="#10b981" stroke-width="2" stroke-linejoin="round"/>
      ${payoffM > 6 ? `<line x1="${px}" y1="${PT}" x2="${px}" y2="${PT+cH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
      <text x="${px}" y="${PT-4}" font-size="8" fill="#64748b" text-anchor="middle" font-family="-apple-system,sans-serif">Paid off</text>` : ''}
      <text x="${PL-4}" y="${PT+4}" font-size="8" fill="#94a3b8" text-anchor="end" font-family="-apple-system,sans-serif">$${Math.round(maxVal/1000)}k</text>
      <text x="${PL-4}" y="${PT+cH+4}" font-size="8" fill="#94a3b8" text-anchor="end" font-family="-apple-system,sans-serif">$0</text>
      <text x="${PL}" y="${H-3}" font-size="8" fill="#94a3b8" font-family="-apple-system,sans-serif">Now</text>
      <text x="${W-PR}" y="${H-3}" font-size="8" fill="#94a3b8" text-anchor="end" font-family="-apple-system,sans-serif">20 yrs</text>
      <text x="${(W-PR-2)}" y="${sy(maxVal)-5}" font-size="9" fill="#059669" text-anchor="end" font-weight="700" font-family="-apple-system,sans-serif">+${fmt(maxVal)} saved</text>
    </svg>`;
  }

  function buildCostsHTML(costs, ecosolar) {
    if (!costs) return '';

    const { mortgage, property_tax, hoa, hoa_note, land_lease, utilities, total, assumptions } = costs;
    const rate = (assumptions.interest_rate * 100).toFixed(2);

    const css = (obj) => Object.entries(obj).map(([k, v]) => `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${v}`).join(';');

    const card   = css({ background: 'rgba(255,255,255,0.92)', border: '1px solid rgba(226,232,240,0.9)', borderRadius: '14px', overflow: 'hidden', marginBottom: '0', fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' });
    const title  = css({ fontSize: '13px', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.07em', padding: '14px 16px 8px', display: 'block' });
    const rows   = css({ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: '7px' });
    const rowS   = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    const lbl    = css({ fontSize: '14px', color: '#475569' });
    const val    = css({ fontSize: '14px', fontWeight: '600', color: '#1e293b' });
    const bold   = css({ fontSize: '15px', fontWeight: '700', color: '#0f172a' });
    const hr     = `<div style="height:1px;background:rgba(226,232,240,0.9);margin:4px 0"></div>`;
    const grn    = css({ fontSize: '14px', fontWeight: '600', color: '#059669' });
    const red    = css({ fontSize: '14px', fontWeight: '600', color: '#dc2626' });
    const note   = css({ fontSize: '13px', color: '#94a3b8', lineHeight: '1.5', padding: '8px 16px 12px', borderTop: '1px solid rgba(226,232,240,0.6)' });

    const row = (l, v, vStyle = val) =>
      `<div style="${rowS}"><span style="${lbl}">${l}</span><span style="${vStyle}">${v}</span></div>`;

    let costRows = row(`Mortgage (${assumptions.down_payment_pct * 100}% down, ${rate}% APR)`, `${fmt(mortgage)}/mo`);
    costRows += row('Property Tax', `${fmt(property_tax)}/mo`);
    costRows += row('HOA', `${fmt(hoa)}/mo`);
    if (hoa_note) costRows += `<div style="font-size:15px;color:#d97706;margin-top:-4px">⚠ ${hoa_note}</div>`;
    if (land_lease) costRows += row('Land Lease', `${fmt(land_lease)}/mo`);
    costRows += row('Utilities (est.)', `${fmt(utilities)}/mo`);

    let ecoHTML = '';
    if (ecosolar) {
      const { logo_url, system_size_kw, system_total_cost, panel_monthly_payment,
              monthly_electric_savings, net_monthly_impact, estimated_payoff_years, note: ecoNote } = ecosolar;

      const afterPayoffTotal = total - utilities + Math.max(0, utilities - monthly_electric_savings);
      const monthlySavedAfter = monthly_electric_savings;
      const chart = buildSavingsChart(ecosolar);

      const heroStyle = css({ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', borderTop: '1px solid rgba(226,232,240,0.9)', padding: '16px' });
      const heroNum   = css({ fontSize: '32px', fontWeight: '700', color: '#059669', lineHeight: '1', letterSpacing: '-0.03em' });
      const heroSub   = css({ fontSize: '14px', color: '#047857', marginTop: '2px' });
      const heroCap   = css({ fontSize: '13px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' });

      const detailToggle = css({ width: '100%', padding: '9px 16px', background: 'none', border: 'none', borderTop: '1px solid rgba(226,232,240,0.7)', color: '#64748b', fontSize: '14px', fontWeight: '500', cursor: 'pointer', textAlign: 'left', fontFamily: '-apple-system,sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const detailRows  = css({ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: '6px' });

      ecoHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-top:1px solid rgba(226,232,240,0.9)">
          <img src="${logo_url}" alt="EcoSolar USA" style="height:26px;width:auto;object-fit:contain">
          <span style="font-size:14px;font-weight:600;color:#059669;background:#d1fae5;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em">Partner</span>
        </div>

        <div style="${heroStyle}">
          <div style="${heroCap}">After panels paid off (est. ${estimated_payoff_years} yrs)</div>
          <div style="${heroNum}">${fmt(monthlySavedAfter)}<span style="font-size:18px;font-weight:500">/mo saved</span></div>
          <div style="${heroSub}">New monthly total: ${fmt(afterPayoffTotal)}/mo · Down from ${fmt(total)}/mo</div>
        </div>

        ${chart ? `<div style="padding:14px 16px 8px">
          <div style="font-size:15px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Cumulative Savings Over Time</div>
          ${chart}
        </div>` : ''}

        <button id="truvala-eco-details-toggle" style="${detailToggle}">
          <span>View financing details</span><span>›</span>
        </button>
        <div id="truvala-eco-details" style="display:none;${detailRows}">
          ${row(`${system_size_kw} kW system upfront`, fmt(system_total_cost))}
          ${row('Monthly panel financing', `-${fmt(panel_monthly_payment)}/mo`, red)}
          ${row('Monthly electric savings', `+${fmt(monthly_electric_savings)}/mo`, grn)}
          ${hr}
          ${row('Net savings during financing', `${fmt(Math.abs(net_monthly_impact))}/mo`, net_monthly_impact <= 0 ? grn : val)}
        </div>
        <div style="${note}">${ecoNote}</div>`;
    }

    return `
      <div style="${card}">
        <span style="${title}">Monthly Cost Estimate</span>
        <div style="${rows}">${costRows}${hr}${row('Estimated Total', `${fmt(total)}/mo`, bold)}</div>
        ${ecoHTML}
      </div>`;
  }

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

  function buildRiskGauge(risk) {
    const levels = ['Low', 'Medium', 'High'];
    const colors = ['#10b981', '#f59e0b', '#ef4444'];
    const r = (risk || '').toLowerCase();
    const idx = r.includes('high') ? 2 : r.includes('low') && !r.includes('high') ? 0 : 1;
    return `
      <div style="margin-top:8px">
        <div style="display:flex;gap:3px;height:6px;border-radius:3px;overflow:hidden">
          ${levels.map((_, i) => `<div style="flex:1;background:${i <= idx ? colors[idx] : '#e2e8f0'};opacity:${i === idx ? 1 : i < idx ? 0.4 : 0.2}"></div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          ${levels.map(l => `<span style="font-size:13px;color:#94a3b8">${l}</span>`).join('')}
        </div>
      </div>`;
  }

  function collapsibleList(items, dotClass, symbol, previewCount = 2) {
    const id = `truvala-expand-${Math.random().toString(36).slice(2, 7)}`;
    const all = items.map((text) => `
      <li class="truvala-list-item">
        <span class="truvala-list-dot ${dotClass}">${symbol}</span>
        <span>${text}</span>
      </li>`);
    if (items.length <= previewCount) return `<ul class="truvala-list">${all.join('')}</ul>`;
    return `
      <ul class="truvala-list">${all.slice(0, previewCount).join('')}</ul>
      <ul class="truvala-list" id="${id}" style="display:none;margin-top:9px">${all.slice(previewCount).join('')}</ul>
      <button class="truvala-expand-btn" data-target="${id}" data-more="${items.length - previewCount}">
        + ${items.length - previewCount} more ›
      </button>`;
  }

  // ─── Risk Analysis UI ────────────────────────────────────────────────────────

  function signalSeverity(signal) {
    if (signal.startsWith('[High]'))   return { color: '#ef4444', label: 'High',   text: signal.replace('[High] ', '') };
    if (signal.startsWith('[Medium]')) return { color: '#f59e0b', label: 'Medium', text: signal.replace('[Medium] ', '') };
    if (signal.startsWith('[Low]'))    return { color: '#10b981', label: 'Low',    text: signal.replace('[Low] ', '') };
    return { color: '#f59e0b', label: null, text: signal };
  }

  function buildRiskModuleHTML(module) {
    if (!module) return '';
    const signals   = module.computed_risk_signals || [];
    const facts     = module.observed_facts || [];
    const inferred  = module.inferred_concerns || [];
    const questions = module.buyer_questions || [];

    const badge = signals.length
      ? `<span class="truvala-module-badge truvala-badge-warn">${signals.length} signal${signals.length !== 1 ? 's' : ''}</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ Clear</span>`;

    const buildSignal = s => {
      const { color, text } = signalSeverity(s);
      return `<div class="truvala-risk-item truvala-signal-item">
        <span class="truvala-signal-dot" style="background:${color}"></span><span>${text}</span>
      </div>`;
    };
    const buildFact = f => `<div class="truvala-risk-item truvala-fact-item">
      <span class="truvala-fact-dot"></span><span>${f}</span>
    </div>`;
    const buildInferred = c => `<div class="truvala-risk-item truvala-inferred-item">${c}</div>`;
    const buildQuestion = q => `<div class="truvala-risk-item truvala-question-item">
      <span class="truvala-question-arrow">→</span><span>${q}</span>
    </div>`;

    // Primary items: signals if any, else facts
    const primaryItems = signals.length ? signals.map(buildSignal) : facts.map(buildFact);
    const primaryLabel = signals.length ? 'Computed Risk Signals' : 'Observed Facts';

    const visible = primaryItems.slice(0, 2);
    const moreId  = `truvala-more-${Math.random().toString(36).slice(2, 7)}`;

    const hiddenParts = [
      ...primaryItems.slice(2),
      signals.length && facts.length
        ? `<div class="truvala-risk-subsection"><div class="truvala-risk-sub-label">Observed Facts</div>${facts.map(buildFact).join('')}</div>` : '',
      inferred.length
        ? `<div class="truvala-risk-subsection truvala-subsection-inferred"><div class="truvala-risk-sub-label">Inferred <span class="truvala-inferred-tag">not confirmed</span></div>${inferred.map(buildInferred).join('')}</div>` : '',
      questions.length
        ? `<div class="truvala-risk-subsection truvala-subsection-questions"><div class="truvala-risk-sub-label">Ask Before You Tour</div>${questions.map(buildQuestion).join('')}</div>` : '',
    ].filter(Boolean);

    return `
      <div class="truvala-risk-module">
        <div class="truvala-risk-module-header">
          <span class="truvala-risk-module-title">${module.section}</span>
          <div class="truvala-risk-module-right">${badge}</div>
        </div>
        <div class="truvala-risk-module-body">
          ${primaryItems.length ? `
            <div class="truvala-risk-subsection">
              <div class="truvala-risk-sub-label">${primaryLabel}</div>
              ${visible.join('')}
            </div>` : ''}
          ${hiddenParts.length ? `
            <div id="${moreId}" style="display:none">${hiddenParts.join('')}</div>
            <button class="truvala-module-show-more" data-target="${moreId}">Show more ›</button>` : ''}
        </div>
      </div>`;
  }

  function buildChecklistHTML(checklist) {
    if (!checklist?.checklist?.length) return '';
    const items  = checklist.checklist;
    const high   = items.filter(i => i.priority === 'High');
    const medium = items.filter(i => i.priority === 'Medium');

    const buildItem = (item) => `
      <div class="truvala-checklist-item">
        <div class="truvala-checklist-top">
          <span class="truvala-checklist-priority priority-${item.priority.toLowerCase()}">${item.priority}</span>
          <span class="truvala-checklist-name">${item.item}</span>
        </div>
        <div class="truvala-checklist-why">${item.why_it_matters}</div>
        <div class="truvala-checklist-meta">
          <span class="truvala-checklist-cost">est. ${item.rough_estimate}</span>
          <span class="truvala-checklist-ask">Ask: ${item.ask}</span>
        </div>
      </div>`;

    const visible = high.slice(0, 2);
    const moreId  = `truvala-more-${Math.random().toString(36).slice(2, 7)}`;

    const hiddenParts = [
      ...high.slice(2).map(buildItem),
      medium.length ? `<div class="truvala-checklist-group-label" style="margin-top:10px">Medium Priority</div>${medium.map(buildItem).join('')}` : '',
    ].filter(Boolean);

    return `
      <div class="truvala-risk-module">
        <div class="truvala-risk-module-header">
          <span class="truvala-risk-module-title">${checklist.section}</span>
          <div class="truvala-risk-module-right">
            <span class="truvala-module-badge truvala-badge-warn">${items.length} items</span>
          </div>
        </div>
        <div class="truvala-risk-module-body">
          ${visible.length ? `
            <div class="truvala-checklist-group-label">High Priority</div>
            ${visible.map(buildItem).join('')}` : ''}
          ${hiddenParts.length ? `
            <div id="${moreId}" style="display:none">${hiddenParts.join('')}</div>
            <button class="truvala-module-show-more" data-target="${moreId}">Show more ›</button>` : ''}
        </div>
      </div>`;
  }

  function buildInterpretedRiskHTML(warnings, questions) {
    const w = (warnings || []);
    const q = (questions || []);
    if (!w.length && !q.length) return '';

    const visible = w.slice(0, 2);
    const moreId  = `truvala-more-${Math.random().toString(36).slice(2, 7)}`;

    const hiddenParts = [
      ...w.slice(2).map(item => `<div class="truvala-interpreted-item">• ${item}</div>`),
      q.length ? `<div class="truvala-interpreted-subheader">Additional questions</div>${q.map(item => `<div class="truvala-interpreted-item">→ ${item}</div>`).join('')}` : '',
    ].filter(Boolean);

    return `
      <div class="truvala-risk-module truvala-interpreted-risk">
        <div class="truvala-risk-module-header">
          <span class="truvala-risk-module-title">Interpreted Risk</span>
          <div class="truvala-risk-module-right">
            <span class="truvala-ai-tag">AI</span>
          </div>
        </div>
        <div class="truvala-risk-module-body">
          <div class="truvala-risk-subsection">
            <p class="truvala-interpreted-note">Model observations derived from the above analysis. Not deterministic.</p>
            ${visible.map(item => `<div class="truvala-interpreted-item">• ${item}</div>`).join('')}
          </div>
          ${hiddenParts.length ? `
            <div id="${moreId}" style="display:none"><div class="truvala-risk-subsection">${hiddenParts.join('')}</div></div>
            <button class="truvala-module-show-more" data-target="${moreId}">Show more ›</button>` : ''}
        </div>
      </div>`;
  }

  function buildRiskAnalysisHTML(report) {
    const rr = report.risk_report;
    const totalSignals = [rr?.age_era, rr?.component_lifespan, rr?.listing_language]
      .flatMap(m => m?.computed_risk_signals || []).length;
    const highItems = rr?.verification_checklist?.checklist?.filter(i => i.priority === 'High').length || 0;

    return `
      <div class="truvala-card truvala-risk-card">
        <div class="truvala-risk-section-header">
          <div class="truvala-card-title" style="margin:0">
            <span class="truvala-card-icon" style="background:#fee2e2;color:#991b1b">⚠</span>
            Risk Analysis
          </div>
          <div class="truvala-risk-header-stats">
            ${totalSignals ? `<span class="truvala-risk-stat">${totalSignals} signals</span>` : ''}
            ${highItems ? `<span class="truvala-risk-stat truvala-risk-stat-high">${highItems} high priority</span>` : ''}
          </div>
        </div>
        ${rr ? `
          ${buildRiskModuleHTML(rr.age_era)}
          ${buildRiskModuleHTML(rr.component_lifespan)}
          ${buildRiskModuleHTML(rr.listing_language)}
          ${buildChecklistHTML(rr.verification_checklist)}
          ${buildInterpretedRiskHTML(report.warnings, report.questions)}
        ` : `<p style="font-size:17px;color:#94a3b8;padding:8px 0">Risk analysis not available for this listing.</p>`}
      </div>`;
  }

  function buildSchoolsDetail(schools, fieldScore) {
    const WEIGHTS    = { elementary: 0.50, high: 0.30, middle: 0.20 };
    const TYPE_LABEL = { elementary: 'Elementary', middle: 'Middle', high: 'High School' };

    const classify = t => {
      t = (t || '').toLowerCase();
      if (t.includes('elementary')) return 'elementary';
      if (t.includes('middle') || t.includes('junior')) return 'middle';
      if (t.includes('high')) return 'high';
      return null;
    };

    // Deduplicate by name, same logic as backend normalizer
    const seen = new Set();
    const deduped = schools.filter(s => {
      const name = (s.name || '').toLowerCase().trim();
      if (name && seen.has(name)) return false;
      if (name) seen.add(name);
      return true;
    });

    // Only rated schools contribute to the composite and appear as cards
    const ratedSchools = deduped.filter(s => classify(s.type) && s.rating != null);

    const byLevel = {};
    ratedSchools.forEach(s => {
      const lvl = classify(s.type);
      (byLevel[lvl] = byLevel[lvl] || []).push(s.rating);
    });
    const levelAvg  = Object.fromEntries(Object.entries(byLevel).map(([l, rs]) => [l, rs.reduce((a,b)=>a+b,0)/rs.length]));
    const present   = Object.fromEntries(Object.entries(WEIGHTS).filter(([l]) => l in levelAvg));
    const totalW    = Object.values(present).reduce((a,b)=>a+b,0);
    const composite = totalW > 0 ? Object.entries(present).reduce((s,[l,w])=>s+levelAvg[l]*w,0)/totalW : null;
    const ratingColor = v => v >= 8 ? '#10b981' : v >= 5 ? '#f59e0b' : '#ef4444';

    const compositeHTML = composite != null ? `
      <div class="truvala-school-composite">
        <span class="truvala-school-composite-label">Composite score</span>
        <span class="truvala-school-composite-val" style="color:${ratingColor(composite)}">${composite.toFixed(1)}<span style="font-size:11px;opacity:0.7">/10</span></span>
      </div>` : '';

    const cards = ratedSchools.map(s => {
      const label = TYPE_LABEL[classify(s.type)];
      return `
        <div class="truvala-school-card">
          <div class="truvala-school-card-info">
            <div class="truvala-school-card-name">${escapeHTML(s.name || 'Unknown')}</div>
            <div class="truvala-school-card-type">${label}</div>
          </div>
          <div class="truvala-school-card-rating" style="color:${ratingColor(s.rating)}">
            ${s.rating}<span style="font-size:10px;opacity:0.7">/10</span>
          </div>
        </div>`;
    }).join('');

    const note = `<div class="truvala-school-weight-note">Weighted: elementary 50% · high school 30% · middle school 20%</div>`;

    return `${compositeHTML}${cards}${note}`;
  }

  function buildReportHTML(report) {
    const tier        = scoreTier(report.score);
    const summaryLine = buildScoreSummaryLine(report.field_scores);

    // Compute top win and top drag for the plain-text summary
    const scoredFields = Object.entries(report.field_scores).map(([key, f]) => {
      const prefKey    = FIELD_PREF_MAP[key];
      const importance = prefKey ? (currentPrefs[prefKey]?.importance ?? 3) : 3;
      const utility    = f.utility ?? 0.5;
      return { ...f, utility, winScore: utility * importance, dragScore: (1 - utility) * importance };
    });
    const topWins  = [...scoredFields].filter(f => f.utility >= 0.75).sort((a, b) => b.winScore  - a.winScore).slice(0, 1);
    const topDrags = [...scoredFields].filter(f => f.utility <= 0.35).sort((a, b) => b.dragScore - a.dragScore).slice(0, 1);

    const fieldRows = Object.entries(report.field_scores).map(([key, f]) => {
      const pct    = Math.round(f.utility * 100);
      const color  = fieldBarColor(f.utility);
      const detail = key === 'schools' && report.listing?.schools?.length
        ? buildSchoolsDetail(report.listing.schools, f)
        : f.explanation;
      return `
        <div class="truvala-field-row">
          <div class="truvala-field-row-main">
            <span class="truvala-field-row-name">${f.label}</span>
            <div class="truvala-field-bar-track truvala-field-row-bar">
              <div class="truvala-field-bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
            <span class="truvala-field-row-pct" style="color:${color}">${pct}%</span>
            <span class="truvala-field-row-chevron">›</span>
          </div>
          <div class="truvala-field-row-detail">${detail}</div>
        </div>`;
    }).join('');

    const skippedMsg = report.skipped_fields?.distance;
    const skippedDistanceRow = skippedMsg ? `
      <div class="truvala-field-row truvala-field-row--skipped">
        <div class="truvala-field-row-static">
          <span class="truvala-field-row-name">Distance</span>
          <div class="truvala-field-bar-track truvala-field-row-bar">
            <div class="truvala-field-bar-fill" style="width:0%;background:#e2e8f0"></div>
          </div>
          <span class="truvala-field-row-pct" style="color:#94a3b8">—</span>
        </div>
        <div class="truvala-field-row-detail" style="display:block">${skippedMsg}</div>
      </div>` : '';


    return `
      <div class="truvala-score-card">
        <div class="truvala-score-section">
          <div class="truvala-score-ring-wrap">${buildScoreRing(report.score)}</div>
          <div class="truvala-score-meta">
            <div class="truvala-score-label">Buyer Fit Score</div>
            <div class="truvala-score-tier" style="color:${tier.color}">${tier.label}</div>
            ${topWins.map(f  => `<div class="truvala-summary-line truvala-summary-positive"><span class="truvala-sum-icon">✓</span><span>${f.explanation}</span></div>`).join('')}
            ${topDrags.map(f => `<div class="truvala-summary-line truvala-summary-concern"><span class="truvala-sum-icon">!</span><span>${f.explanation}</span></div>`).join('')}
          </div>
        </div>
        <div class="truvala-field-rows" id="truvala-breakdown-grid">
          ${fieldRows}${skippedDistanceRow}
        </div>
      </div>

      ${report.monthly_costs ? `
      <button id="truvala-costs-btn" style="width:100%;height:48px;padding:0 18px;border-radius:12px;border:none;background:#1e3a8a;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,sans-serif;box-shadow:0 4px 14px rgba(30,58,138,0.3);letter-spacing:-0.01em;white-space:nowrap;flex-shrink:0;box-sizing:border-box">
        <span>Monthly Costs &amp; Savings</span>
        <span style="font-size:18px;opacity:0.7;flex-shrink:0">›</span>
      </button>` : ''}

      ${buildCompactRiskHTML(report)}`;
  }

  // ─── Field popover ───────────────────────────────────────────────────────────

  function showFieldPopover(chip) {
    const popover = document.getElementById('truvala-field-popover');

    // Toggle off if same chip
    if (chip.classList.contains('active')) {
      closeFieldPopover();
      return;
    }

    const key = chip.dataset.fieldKey;
    if (!currentReport?.field_scores?.[key]) return;
    const f = currentReport.field_scores[key];
    const prefValue = formatPrefValue(key);
    const imp = getPrefImportance(key);
    const impLevel = imp ? impToLevel(imp) : null;
    const impLabel = { low: 'Low', med: 'Med', high: 'High' }[impLevel];

    popover.querySelector('.truvala-popover-title').textContent = f.label;
    const prefEl = popover.querySelector('.truvala-popover-pref');
    prefEl.innerHTML = prefValue ? `Your preference: <strong>${prefValue}</strong>` : '';
    prefEl.style.display = prefValue ? '' : 'none';
    const impEl = popover.querySelector('.truvala-popover-imp');
    impEl.innerHTML = impLabel ? `Importance: <span class="truvala-imp-badge imp-${impLevel}">${impLabel}</span>` : '';
    impEl.style.display = impLabel ? '' : 'none';
    popover.querySelector('.truvala-popover-expl').textContent = f.explanation;

    document.querySelectorAll('.truvala-breakdown-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    // Position: span the full grid width, appear above the clicked chip
    const grid = document.getElementById('truvala-breakdown-grid');
    const gridRect = grid.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();

    popover.style.display = 'flex';
    popover.style.width = `${gridRect.width}px`;
    popover.style.left = `${gridRect.left}px`;

    const popH = popover.offsetHeight;
    const spaceAbove = chipRect.top - gridRect.top;
    if (spaceAbove >= popH + 8) {
      popover.style.top = `${chipRect.top - popH - 8}px`;
    } else {
      popover.style.top = `${chipRect.bottom + 8}px`;
    }
  }

  function closeFieldPopover() {
    const popover = document.getElementById('truvala-field-popover');
    if (popover) popover.style.display = 'none';
    document.querySelectorAll('.truvala-breakdown-chip').forEach(c => c.classList.remove('active'));
  }

  // ─── Risk drawer ─────────────────────────────────────────────────────────────

  function computeRiskLevels(rr) {
    if (!rr) return null;

    // Age & Era — pre-1978 is a federal threshold (lead paint); hard High
    const ageSignals = rr.age_era?.computed_risk_signals || [];
    const hasPre1978 = ageSignals.some(s =>
      s.toLowerCase().includes('lead paint') || s.toLowerCase().includes('asbestos')
    );
    const ageLevel = hasPre1978 ? 'high' : ageSignals.length > 0 ? 'medium' : 'low';
    const ageFacts = rr.age_era?.observed_facts || [];
    const ageYearFact = ageFacts.find(f => f.startsWith('Built in'));
    const ageDesc = ageYearFact
      ? (hasPre1978 ? `${ageYearFact.replace('Built in ', '')} — hazard era` : ageYearFact)
      : ageSignals.length > 0 ? 'Era concerns noted' : 'Modern construction';

    // Components — count past-lifespan signals (not "approaching")
    const compSignals = rr.component_lifespan?.computed_risk_signals || [];
    const pastLifespan = compSignals.filter(s => s.includes('replacement verification recommended')).length;
    const approaching  = compSignals.filter(s => s.includes('approaching')).length;
    const compLevel = pastLifespan >= 3 ? 'high' : pastLifespan >= 1 || approaching >= 2 ? 'medium' : 'low';
    const compDesc  = pastLifespan + approaching === 0
      ? 'Systems within lifespan'
      : `${pastLifespan + approaching} system${pastLifespan + approaching !== 1 ? 's' : ''} flagged`;

    // Listing Language — use the highest severity flag found
    const langSignals = rr.listing_language?.computed_risk_signals || [];
    const langLevel = langSignals.some(s => s.startsWith('[High]'))   ? 'high'
                    : langSignals.some(s => s.startsWith('[Medium]')) ? 'medium'
                    : langSignals.some(s => s.startsWith('[Low]'))    ? 'low'
                    : 'low';
    const langDesc = langSignals.length === 0 ? 'No red flags found'
                   : langLevel === 'high'     ? 'High-risk language found'
                   : langLevel === 'medium'   ? 'Caution language detected'
                   : 'Minor signals only';

    // Verification Gaps — count of High-priority unconfirmed items
    const highItems = rr.verification_checklist?.checklist?.filter(i => i.priority === 'High').length || 0;
    const verifyLevel = highItems >= 5 ? 'high' : highItems >= 2 ? 'medium' : 'low';
    const verifyDesc  = highItems === 0 ? 'Nothing critical missing'
                      : `${highItems} high-priority gap${highItems !== 1 ? 's' : ''}`;

    return [
      { key: 'age',      label: 'Age & Era',       level: ageLevel,    desc: ageDesc },
      { key: 'comp',     label: 'Components',       level: compLevel,   desc: compDesc },
      { key: 'language', label: 'Listing Flags',    level: langLevel,   desc: langDesc },
      { key: 'verify',   label: 'Verify Gaps',      level: verifyLevel, desc: verifyDesc },
    ];
  }

  function riskLevelColor(level) {
    return { low: '#10b981', medium: '#f59e0b', high: '#ef4444' }[level] || '#94a3b8';
  }

  function buildCategoryCard(cat) {
    const color = riskLevelColor(cat.level);
    const pos   = { low: 0, medium: 1, high: 2 }[cat.level] ?? 0;
    const label = cat.level.charAt(0).toUpperCase() + cat.level.slice(1);
    const segs  = [0, 1, 2].map(i =>
      `<div class="truvala-gauge-seg" style="background:${i === pos ? color : '#e2e8f0'}"></div>`
    ).join('');
    return `
      <div class="truvala-risk-cat-card">
        <div class="truvala-risk-cat-name">${cat.label}</div>
        <div class="truvala-risk-gauge">${segs}</div>
        <div class="truvala-risk-cat-footer">
          <span class="truvala-risk-cat-level" style="color:${color}">${label}</span>
          <span class="truvala-risk-cat-desc">${cat.desc}</span>
        </div>
      </div>`;
  }

  function buildCompactRiskHTML(report) {
    const rr     = report.risk_report;
    const levels = computeRiskLevels(rr);

    return `
      <div class="truvala-card truvala-risk-compact-card">
        <div class="truvala-risk-compact-header">
          <div class="truvala-card-title" style="margin:0">
            <span class="truvala-card-icon" style="background:#fee2e2;color:#991b1b">⚠</span>
            Risk Analysis
          </div>
          <span class="truvala-risk-badge ${riskClass(report.risk)}">${report.risk} risk</span>
        </div>
        ${levels ? `
          <div class="truvala-risk-cat-grid">
            ${levels.map(buildCategoryCard).join('')}
          </div>` : `
          <p class="truvala-risk-cat-empty">Risk data not available for this listing.</p>`}
        <button class="truvala-full-risk-btn" id="truvala-full-risk-btn">
          <span>Full risk report</span>
          <span class="truvala-full-risk-arrow">→</span>
        </button>
      </div>`;
  }

  function buildFullRiskHTML(report) {
    const rr = report.risk_report;
    if (!rr) return '<p class="truvala-drawer-empty">Risk data not available for this listing.</p>';
    return `
      ${buildRiskModuleHTML(rr.age_era)}
      ${buildRiskModuleHTML(rr.component_lifespan)}
      ${buildRiskModuleHTML(rr.listing_language)}
      ${buildChecklistHTML(rr.verification_checklist)}
      ${buildInterpretedRiskHTML(report.warnings, report.questions)}`;
  }

  function openRiskDrawer() {
    if (!currentReport) return;
    if (!riskDrawerBuilt) {
      document.getElementById('truvala-drawer-modules').innerHTML = buildFullRiskHTML(currentReport);
      document.getElementById('truvala-drawer-chat').innerHTML    = buildChatSectionHTML();
      riskDrawerBuilt = true;
      initChat();
    }
    document.getElementById('truvala-risk-drawer').classList.add('truvala-visible');
  }

  function closeRiskDrawer() {
    document.getElementById('truvala-risk-drawer').classList.remove('truvala-visible');
  }

  // ─── Pinned homes ─────────────────────────────────────────────────────────────

  function loadPinnedHomes() {
    chrome.storage.local.get(['truvala_pinned'], result => {
      pinnedHomes = result.truvala_pinned || [];
      updateFolderUI();
      // Auto-restore report if this page is already pinned
      const match = pinnedHomes.find(h => h.url === window.location.href);
      if (match) restorePinnedReport(match);
    });
  }

  function restorePinnedReport(home) {
    storeReport(home.report, home.address, home.screenshot || null);
  }

  function savePinnedHomes() {
    chrome.storage.local.set({ truvala_pinned: pinnedHomes });
  }

  function pinCurrentListing(screenshot = null) {
    if (!currentReport) return;
    const url = window.location.href;
    if (pinnedHomes.find(h => h.url === url)) {
      showToast('Already pinned');
      return;
    }
    if (pinnedHomes.length >= 4) {
      showToast('4/4 pinned — remove a listing to add more');
      return;
    }
    const id = Date.now().toString();
    pinnedHomes.push({ id, address: currentAddress, url, report: currentReport, screenshot });
    savePinnedHomes();
    updateFolderUI();
    showToast('Pinned!');
  }

  function unpinHome(id) {
    pinnedHomes = pinnedHomes.filter(h => h.id !== id);
    savePinnedHomes();
    if (pinnedHomes.length === 0 && folderOpen) {
      folderOpen = false;
      document.getElementById('truvala-fan').classList.remove('truvala-fan-open');
    } else if (folderOpen) {
      renderFan();
    }
    updateFolderUI();
  }

  function updateFolderUI() {
    const folder  = document.getElementById('truvala-folder');
    const counter = document.getElementById('truvala-folder-counter');
    const pinBtn  = document.getElementById('truvala-pin-btn');
    if (!folder) return;
    const count = pinnedHomes.length;
    counter.textContent = count;
    folder.classList.toggle('truvala-hidden', count === 0);
    if (pinBtn) {
      const alreadyPinned = !!pinnedHomes.find(h => h.url === window.location.href);
      pinBtn.classList.toggle('truvala-pin-active', alreadyPinned);
    }
  }

  function toggleFolder() {
    if (pinnedHomes.length === 0) return;
    folderOpen = !folderOpen;
    document.getElementById('truvala-fan').classList.toggle('truvala-fan-open', folderOpen);
    if (folderOpen) renderFan();
  }

  function renderFan() {
    const fan = document.getElementById('truvala-fan');
    if (!fan) return;
    fan.innerHTML = pinnedHomes.map(h => `
      <div class="truvala-fan-bubble" data-url="${escapeHTML(h.url)}">
        <div class="truvala-fan-score" style="color:${scoreColor(h.report.score)}">${h.report.score}</div>
        <div class="truvala-fan-info">
          <div class="truvala-fan-label">Buyer Fit</div>
          <div class="truvala-fan-address">${escapeHTML(h.address)}</div>
        </div>
        <div class="truvala-fan-chevron">›</div>
        <button class="truvala-fan-remove" data-id="${h.id}" aria-label="Remove">✕</button>
      </div>`).join('') + `
      <button class="truvala-compare-open-btn" id="truvala-compare-open">
        Compare ${pinnedHomes.length} listing${pinnedHomes.length !== 1 ? 's' : ''}
        <span class="truvala-compare-open-arrow">→</span>
      </button>`;
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────

  function showToast(msg) {
    const toast = document.getElementById('truvala-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('truvala-toast-show');
    setTimeout(() => toast.classList.remove('truvala-toast-show'), 2600);
  }

  // ─── Compare overlay ─────────────────────────────────────────────────────────

  function openCompare() {
    folderOpen = false;
    document.getElementById('truvala-fan').classList.remove('truvala-fan-open');
    compareChatMessages = [];
    document.getElementById('truvala-compare-chat-log').innerHTML = '';

    const grid = document.getElementById('truvala-compare-grid');
    grid.innerHTML = pinnedHomes.map((h, i) => `
      <div class="truvala-compare-col-wrap" data-home-index="${i}">
        <button class="truvala-col-tab" style="display:none" aria-label="Back to report">
          <div class="truvala-mini-score" style="color:${scoreColor(h.report.score)}">${h.report.score}</div>
          <div class="truvala-mini-info">
            <div class="truvala-mini-label">Buyer Fit</div>
            <div class="truvala-mini-address">${escapeHTML(h.address)}</div>
          </div>
          <div class="truvala-mini-chevron">›</div>
        </button>
        <div class="truvala-compare-col">
          <div class="truvala-compare-col-header">
            <div class="truvala-compare-col-address">${escapeHTML(h.address)}</div>
            <a class="truvala-compare-col-link" href="${escapeHTML(h.url)}" target="_blank">View listing ↗</a>
          </div>
          <div class="truvala-col-body-slider">
            <div class="truvala-col-main truvala-compare-col-body">
              ${h.screenshot ? `<img class="truvala-report-screenshot" src="${h.screenshot}" alt="${escapeHTML(h.address)}">` : ''}
              ${buildReportHTML(h.report)}
            </div>
            <div class="truvala-col-risk truvala-compare-col-body"></div>
          </div>
        </div>
      </div>`).join('');

    document.getElementById('truvala-compare-overlay').classList.add('truvala-compare-open');
    initCompareChat();
  }

  function closeCompare() {
    document.getElementById('truvala-compare-overlay').classList.remove('truvala-compare-open');
  }

  // ─── Compare column risk flip ─────────────────────────────────────────────────

  function flipToRisk(wrap, home) {
    const col  = wrap.querySelector('.truvala-compare-col');
    const risk = col.querySelector('.truvala-col-risk');
    if (!risk.innerHTML.trim()) {
      risk.innerHTML = `<div class="truvala-col-risk-content">${buildFullRiskHTML(home.report)}</div>`;
    }
    col.classList.add('is-flipped');
    wrap.querySelector('.truvala-col-tab').style.display = 'flex';
  }

  function flipBackFromRisk(wrap) {
    wrap.querySelector('.truvala-compare-col').classList.remove('is-flipped');
    wrap.querySelector('.truvala-col-tab').style.display = 'none';
  }

  // ─── Compare chat ─────────────────────────────────────────────────────────────

  function appendCompareChatMessage(role, content) {
    const log = document.getElementById('truvala-compare-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `truvala-chat-msg truvala-msg-${role}`;
    div.innerHTML = role === 'user'
      ? `<div class="truvala-msg-bubble">${escapeHTML(content)}</div>`
      : `<div class="truvala-msg-avatar">T</div><div class="truvala-msg-bubble">${escapeHTML(content)}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function showCompareChatTyping() {
    const log = document.getElementById('truvala-compare-chat-log');
    if (!log || document.getElementById('truvala-compare-typing')) return;
    const div = document.createElement('div');
    div.id = 'truvala-compare-typing';
    div.className = 'truvala-chat-msg truvala-msg-assistant';
    div.innerHTML = `
      <div class="truvala-msg-avatar">T</div>
      <div class="truvala-msg-bubble truvala-typing-bubble">
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
      </div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function removeCompareChatTyping() {
    document.getElementById('truvala-compare-typing')?.remove();
  }

  function renderCompareSuggestions(questions) {
    const log = document.getElementById('truvala-compare-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'truvala-chat-suggestions';
    div.innerHTML = questions.map(q => `<button class="truvala-suggestion-chip">${escapeHTML(q)}</button>`).join('');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function initCompareChat() {
    showCompareChatTyping();
    const allListings = pinnedHomes.map(h => ({
      address:        h.address,
      score:          h.report.score,
      risk:           h.report.risk,
      capex_estimate: h.report.capex_estimate,
      listing:        h.report.listing   || {},
      risk_report:    h.report.risk_report || {},
    }));
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [],
          risk_report: {}, listing: {}, preferences: currentPrefs,
          score: 0, capex_estimate: '',
          compare_listings: allListings,
        }),
      });
      const data = await res.json();
      removeCompareChatTyping();
      appendCompareChatMessage('assistant', data.message);
      if (data.suggested_questions?.length) renderCompareSuggestions(data.suggested_questions);
    } catch {
      removeCompareChatTyping();
      appendCompareChatMessage('assistant', "I've reviewed all your pinned listings. What would you like to compare?");
    }
  }

  async function sendCompareChatMessage(content) {
    const text = content.trim();
    if (!text) return;
    const input   = document.getElementById('truvala-compare-input');
    const sendBtn = document.getElementById('truvala-compare-send');
    if (input)   input.disabled   = true;
    if (sendBtn) sendBtn.disabled = true;
    document.querySelector('#truvala-compare-chat-log .truvala-chat-suggestions')?.remove();
    compareChatMessages.push({ role: 'user', content: text });
    appendCompareChatMessage('user', text);
    if (input) input.value = '';
    showCompareChatTyping();
    const allListings = pinnedHomes.map(h => ({
      address: h.address, score: h.report.score, risk: h.report.risk,
      capex_estimate: h.report.capex_estimate,
      listing: h.report.listing || {}, risk_report: h.report.risk_report || {},
    }));
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: compareChatMessages,
          risk_report: {}, listing: {}, preferences: currentPrefs,
          score: 0, capex_estimate: '',
          compare_listings: allListings,
        }),
      });
      const data = await res.json();
      removeCompareChatTyping();
      compareChatMessages.push({ role: 'assistant', content: data.message });
      appendCompareChatMessage('assistant', data.message);
    } catch {
      removeCompareChatTyping();
      const err = "Sorry, something went wrong. Please try again.";
      compareChatMessages.push({ role: 'assistant', content: err });
      appendCompareChatMessage('assistant', err);
    } finally {
      if (input)   { input.disabled = false; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ─── Crop / screenshot ────────────────────────────────────────────────────────

  function startCropMode() {
    if (!currentReport) return;
    if (state === 'panel') setState('minimized');

    const rect = document.getElementById('truvala-crop-rect');
    const W = Math.round(Math.min(window.innerWidth  * 0.58, 700));
    const H = Math.round(Math.min(window.innerHeight * 0.45, 450));
    const L = Math.round((window.innerWidth  - W) / 2);
    const T = Math.round((window.innerHeight - H) / 2);
    Object.assign(rect.style, { left: L+'px', top: T+'px', width: W+'px', height: H+'px' });

    document.getElementById('truvala-crop-overlay').classList.add('truvala-crop-active');
  }

  function stopCropMode() {
    document.getElementById('truvala-crop-overlay').classList.remove('truvala-crop-active');
  }

  async function captureAndPin() {
    const rect = document.getElementById('truvala-crop-rect');
    const x = parseFloat(rect.style.left);
    const y = parseFloat(rect.style.top);
    const w = parseFloat(rect.style.width);
    const h = parseFloat(rect.style.height);

    stopCropMode();

    // Hide all Truvala UI so the screenshot is clean listing content
    const root = document.getElementById('truvala-root');
    root.style.display = 'none';
    // Two rAFs ensure at least one full repaint before capture
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let screenshot = null;
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureTab' }, res => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(res);
        });
      });

      if (response?.dataUrl) {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        await new Promise(r => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img,
              Math.round(x * dpr), Math.round(y * dpr),
              Math.round(w * dpr), Math.round(h * dpr),
              0, 0, canvas.width, canvas.height
            );
            r();
          };
          img.src = response.dataUrl;
        });
        screenshot = canvas.toDataURL('image/jpeg', 0.82);
      }
    } catch (err) {
      console.error('[Truvala] Screenshot failed:', err);
    } finally {
      root.style.display = '';
    }

    pinCurrentListing(screenshot);
  }

  function bindCropEvents() {
    const rect = document.getElementById('truvala-crop-rect');
    let drag = null, resize = null;

    rect.addEventListener('mousedown', e => {
      if (e.target.closest('.truvala-crop-handle') || e.target.closest('.truvala-crop-actions')) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, l: parseFloat(rect.style.left), t: parseFloat(rect.style.top) };
      document.body.style.cursor = 'move';
    });

    rect.querySelectorAll('.truvala-crop-handle').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        resize = {
          type: handle.dataset.handle,
          x: e.clientX, y: e.clientY,
          l: parseFloat(rect.style.left), t: parseFloat(rect.style.top),
          w: parseFloat(rect.style.width), h: parseFloat(rect.style.height),
        };
        document.body.style.cursor = getComputedStyle(handle).cursor;
      });
    });

    document.addEventListener('mousemove', e => {
      if (drag) {
        rect.style.left = (drag.l + e.clientX - drag.x) + 'px';
        rect.style.top  = (drag.t + e.clientY - drag.y) + 'px';
      }
      if (resize) {
        const dx = e.clientX - resize.x, dy = e.clientY - resize.y;
        const MIN = 80;
        let { l, t, w, h } = resize;
        if (resize.type.includes('e')) w = Math.max(MIN, w + dx);
        if (resize.type.includes('s')) h = Math.max(MIN, h + dy);
        if (resize.type.includes('w')) { const nw = Math.max(MIN, w - dx); l += w - nw; w = nw; }
        if (resize.type.includes('n')) { const nh = Math.max(MIN, h - dy); t += h - nh; h = nh; }
        Object.assign(rect.style, { left: l+'px', top: t+'px', width: w+'px', height: h+'px' });
      }
    });

    document.addEventListener('mouseup', () => {
      if (drag || resize) document.body.style.cursor = '';
      drag = null; resize = null;
    });

    document.getElementById('truvala-crop-cancel').addEventListener('click', stopCropMode);
    document.getElementById('truvala-crop-confirm').addEventListener('click', captureAndPin);
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────────

  const CHAT_URL = 'http://localhost:8000/chat';

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildChatSectionHTML() {
    return `
      <div class="truvala-chat-section">
        <div class="truvala-chat-divider">
          <span class="truvala-chat-divider-label">Ask Truvala</span>
          <span class="truvala-ai-tag">AI</span>
        </div>
        <div class="truvala-chat-log" id="truvala-chat-log"></div>
      </div>`;
  }

  function appendChatMessage(role, content) {
    const log = document.getElementById('truvala-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `truvala-chat-msg truvala-msg-${role}`;
    div.innerHTML = role === 'user'
      ? `<div class="truvala-msg-bubble">${escapeHTML(content)}</div>`
      : `<div class="truvala-msg-avatar">T</div><div class="truvala-msg-bubble">${escapeHTML(content)}</div>`;
    log.appendChild(div);
    scrollChatToBottom();
  }

  function showChatTyping() {
    const log = document.getElementById('truvala-chat-log');
    if (!log || document.getElementById('truvala-chat-typing')) return;
    const div = document.createElement('div');
    div.id = 'truvala-chat-typing';
    div.className = 'truvala-chat-msg truvala-msg-assistant';
    div.innerHTML = `
      <div class="truvala-msg-avatar">T</div>
      <div class="truvala-msg-bubble truvala-typing-bubble">
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
      </div>`;
    log.appendChild(div);
    scrollChatToBottom();
  }

  function removeChatTyping() {
    document.getElementById('truvala-chat-typing')?.remove();
  }

  function renderSuggestedQuestions(questions) {
    const log = document.getElementById('truvala-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.id = 'truvala-chat-suggestions';
    div.className = 'truvala-chat-suggestions';
    div.innerHTML = questions
      .map(q => `<button class="truvala-suggestion-chip">${escapeHTML(q)}</button>`)
      .join('');
    log.appendChild(div);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const log = document.getElementById('truvala-chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  async function initChat() {
    if (!currentReport) return;
    showChatTyping();
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [],
          risk_report: currentReport.risk_report || {},
          listing:     currentReport.listing     || {},
          preferences: currentPrefs,
          score:       currentReport.score       || 0,
          capex_estimate: currentReport.capex_estimate || '',
        }),
      });
      const data = await res.json();
      removeChatTyping();
      appendChatMessage('assistant', data.message);
      if (data.suggested_questions?.length) {
        renderSuggestedQuestions(data.suggested_questions);
      }
    } catch {
      removeChatTyping();
      appendChatMessage('assistant', "Hi! I've reviewed this listing's risk profile and I'm ready to answer your questions.");
    }
  }

  async function sendChatMessage(content) {
    const text = content.trim();
    if (!text || !currentReport) return;

    const input   = document.getElementById('truvala-chat-input');
    const sendBtn = document.getElementById('truvala-chat-send');
    if (input)   input.disabled   = true;
    if (sendBtn) sendBtn.disabled = true;

    document.getElementById('truvala-chat-suggestions')?.remove();
    chatMessages.push({ role: 'user', content: text });
    appendChatMessage('user', text);
    if (input) input.value = '';

    showChatTyping();
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages:    chatMessages,
          risk_report: currentReport.risk_report || {},
          listing:     currentReport.listing     || {},
          preferences: currentPrefs,
          score:       currentReport.score       || 0,
          capex_estimate: currentReport.capex_estimate || '',
        }),
      });
      const data = await res.json();
      removeChatTyping();
      chatMessages.push({ role: 'assistant', content: data.message });
      appendChatMessage('assistant', data.message);
    } catch {
      removeChatTyping();
      const errMsg = "Sorry, something went wrong. Please try again.";
      chatMessages.push({ role: 'assistant', content: errMsg });
      appendChatMessage('assistant', errMsg);
    } finally {
      if (input)   { input.disabled = false; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    }
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

      <div id="truvala-backdrop"></div>

      <div id="truvala-risk-drawer" class="truvala-risk-drawer" role="complementary" aria-label="Full risk report">
        <div class="truvala-drawer-header">
          <div class="truvala-drawer-title">
            <span style="font-size:17px">⚠</span>
            Full Risk Report
          </div>
          <button class="truvala-panel-close" id="truvala-risk-drawer-close" aria-label="Close risk report">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="truvala-drawer-modules" id="truvala-drawer-modules"></div>
        <div class="truvala-drawer-chat" id="truvala-drawer-chat"></div>
        <div class="truvala-chat-input-area">
          <input class="truvala-chat-input" id="truvala-chat-input"
            type="text" placeholder="Ask about this listing…" autocomplete="off" spellcheck="false">
          <button class="truvala-chat-send" id="truvala-chat-send" aria-label="Send">↑</button>
        </div>
      </div>

      <div id="truvala-field-popover" class="truvala-field-popover" style="display:none" role="tooltip">
        <div class="truvala-popover-header">
          <span class="truvala-popover-title"></span>
          <button class="truvala-popover-close" id="truvala-popover-close" aria-label="Close">✕</button>
        </div>
        <div class="truvala-popover-pref"></div>
        <div class="truvala-popover-imp"></div>
        <div class="truvala-popover-expl"></div>
      </div>

      <button id="truvala-pin-btn" class="truvala-pin-btn truvala-hidden" aria-label="Pin this listing">
        ${ICON_PIN}
      </button>

      <button id="truvala-folder" class="truvala-folder truvala-hidden" aria-label="Pinned listings">
        ${ICON_FOLDER}
        <span id="truvala-folder-counter" class="truvala-folder-counter">0</span>
      </button>

      <div id="truvala-fan" class="truvala-fan"></div>

      <div id="truvala-compare-overlay" class="truvala-compare-overlay">
        <div class="truvala-compare-header">
          <div class="truvala-compare-title">
            <span style="font-size:17px">⊞</span> Compare Listings
          </div>
          <button class="truvala-panel-close" id="truvala-compare-close" aria-label="Close compare">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="truvala-compare-body">
          <div class="truvala-compare-grid" id="truvala-compare-grid"></div>
          <div class="truvala-compare-chat-panel" id="truvala-compare-chat-panel">
            <div class="truvala-compare-chat-top">
              <div class="truvala-chat-divider" style="padding:12px 16px 8px">
                <span class="truvala-chat-divider-label">Ask Truvala</span>
                <span class="truvala-ai-tag">AI</span>
              </div>
              <div class="truvala-compare-chat-log" id="truvala-compare-chat-log"></div>
            </div>
            <div class="truvala-chat-input-area">
              <input class="truvala-chat-input" id="truvala-compare-input"
                type="text" placeholder="Compare these listings…" autocomplete="off" spellcheck="false">
              <button class="truvala-chat-send" id="truvala-compare-send" aria-label="Send">↑</button>
            </div>
          </div>
        </div>
      </div>

      <div id="truvala-toast" class="truvala-toast"></div>

      <div id="truvala-crop-overlay">
        <div id="truvala-crop-backdrop"></div>
        <div id="truvala-crop-rect">
          <div class="truvala-crop-handle" data-handle="nw"></div>
          <div class="truvala-crop-handle" data-handle="ne"></div>
          <div class="truvala-crop-handle" data-handle="sw"></div>
          <div class="truvala-crop-handle" data-handle="se"></div>
          <div class="truvala-crop-toolbar">
            <span class="truvala-crop-hint">Drag to move · corners to resize</span>
            <div class="truvala-crop-actions">
              <button id="truvala-crop-cancel" class="truvala-crop-btn-cancel">Cancel</button>
              <button id="truvala-crop-confirm" class="truvala-crop-btn-confirm">Capture &amp; Pin</button>
            </div>
          </div>
        </div>
      </div>`;

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

    // Pin button → start crop/screenshot flow
    document.getElementById('truvala-pin-btn').addEventListener('click', startCropMode);

    bindCropEvents();

    // Folder opens/closes the fan
    document.getElementById('truvala-folder').addEventListener('click', toggleFolder);

    // Fan: bubble navigation + remove + compare
    document.getElementById('truvala-fan').addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.truvala-fan-remove');
      if (removeBtn) { e.stopPropagation(); unpinHome(removeBtn.dataset.id); return; }
      if (e.target.closest('#truvala-compare-open')) { openCompare(); return; }
      const bubble = e.target.closest('.truvala-fan-bubble');
      if (bubble && bubble.dataset.url) {
        const home = pinnedHomes.find(h => h.url === bubble.dataset.url);
        if (!home) return;
        folderOpen = false;
        document.getElementById('truvala-fan').classList.remove('truvala-fan-open');
        if (window.location.href === home.url) {
          restorePinnedReport(home);
        } else {
          window.open(home.url, '_blank');
        }
      }
    });

    // Compare overlay close
    document.getElementById('truvala-compare-close').addEventListener('click', closeCompare);

    // Clicking blank space in the compare grid minimizes back to the page
    document.getElementById('truvala-compare-grid').addEventListener('click', e => {
      if (!e.target.closest('.truvala-compare-col-wrap')) closeCompare();
    }, true);

    // Compare grid — all button interactions handled here via relative DOM traversal
    document.getElementById('truvala-compare-grid').addEventListener('click', e => {
      const wrap = e.target.closest('.truvala-compare-col-wrap');
      if (!wrap) return;
      const idx  = parseInt(wrap.dataset.homeIndex);
      const home = pinnedHomes[idx];
      const col  = wrap.querySelector('.truvala-compare-col');

      // Floating tab → flip back
      if (e.target.closest('.truvala-col-tab')) { flipBackFromRisk(wrap); return; }

      // Full risk → flip column
      if (e.target.closest('.truvala-full-risk-btn')) { flipToRisk(wrap, home); return; }

      // Show more (risk drawer show/hide)
      const showMore = e.target.closest('.truvala-module-show-more');
      if (showMore) {
        const t = document.getElementById(showMore.dataset.target);
        if (t) { const open = t.style.display !== 'none'; t.style.display = open ? 'none' : ''; showMore.textContent = open ? 'Show more ›' : 'Show less ‹'; }
        return;
      }

      // Costs toggle (relative — no global ID lookup)
      if (e.target.closest('[id="truvala-costs-btn"]')) {
        const btn  = e.target.closest('[id="truvala-costs-btn"]');
        const body = btn.closest('.truvala-compare-col-body');
        const existing = body.querySelector('.truvala-compare-costs-section');
        if (existing) { existing.remove(); return; }
        if (!home?.report?.monthly_costs) return;
        const section = document.createElement('div');
        section.className = 'truvala-compare-costs-section';
        section.innerHTML = buildCostsHTML(home.report.monthly_costs, home.report.ecosolar);
        btn.after(section);
        return;
      }

      // Score breakdown toggle (relative)
      if (e.target.closest('.truvala-breakdown-toggle')) {
        const toggle  = e.target.closest('.truvala-breakdown-toggle');
        const body    = toggle.nextElementSibling;
        const chevron = toggle.querySelector('.truvala-breakdown-main-chevron');
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(180deg)';
        toggle.style.borderRadius = open ? '0 0 16px 16px' : '0';
        return;
      }

      // Field row inline expand (compare mode)
      if (e.target.closest('.truvala-field-row-main')) {
        const main    = e.target.closest('.truvala-field-row-main');
        const row     = main.closest('.truvala-field-row');
        const detail  = row.querySelector('.truvala-field-row-detail');
        const chevron = main.querySelector('.truvala-field-row-chevron');
        const open    = getComputedStyle(detail).display !== 'none';
        detail.style.display = open ? 'none' : 'block';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
        row.classList.toggle('truvala-field-row--open', !open);
        return;
      }

      // Collapsible list expand
      const expandBtn = e.target.closest('.truvala-expand-btn[data-target]');
      if (expandBtn) {
        const t = document.getElementById(expandBtn.dataset.target);
        if (t) { const open = t.style.display !== 'none'; t.style.display = open ? 'none' : ''; expandBtn.textContent = open ? `+ ${expandBtn.dataset.more} more ›` : 'Show less'; }
        return;
      }

      // Eco details toggle (relative)
      if (e.target.closest('[id="truvala-eco-details-toggle"]')) {
        const btn     = e.target.closest('[id="truvala-eco-details-toggle"]');
        const details = btn.nextElementSibling;
        if (details) {
          const open = details.style.display !== 'none';
          details.style.display = open ? 'none' : 'flex';
          if (!open) { details.style.flexDirection = 'column'; details.style.gap = '6px'; }
          btn.querySelector('span:last-child').textContent  = open ? '›' : '˅';
          btn.querySelector('span:first-child').textContent = open ? 'View financing details' : 'Hide financing details';
        }
        return;
      }
    });

    // Compare chat send + enter
    document.getElementById('truvala-compare-send').addEventListener('click', () => {
      sendCompareChatMessage(document.getElementById('truvala-compare-input').value);
    });
    document.getElementById('truvala-compare-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompareChatMessage(e.target.value); }
    });

    // Compare chat suggestion chips
    document.getElementById('truvala-compare-chat-panel').addEventListener('click', e => {
      const chip = e.target.closest('.truvala-suggestion-chip');
      if (chip) sendCompareChatMessage(chip.textContent);
    });

    // Mini bubble reopens the panel
    document.getElementById('truvala-mini').addEventListener('click', () => {
      setState('panel');
    });

    // Bubble close: if editing go back to minimized, else go idle
    document.getElementById('truvala-bubble-close').addEventListener('click', () => {
      setState(currentReport ? 'minimized' : 'idle');
    });

    // Backdrop click: minimize and close risk drawer
    document.getElementById('truvala-backdrop').addEventListener('click', () => {
      closeRiskDrawer();
      setState('minimized');
    });

    // Panel close: minimize and close risk drawer
    document.getElementById('truvala-panel-close').addEventListener('click', () => {
      closeRiskDrawer();
      setState('minimized');
    });

    // Risk drawer close
    document.getElementById('truvala-risk-drawer-close').addEventListener('click', closeRiskDrawer);

    // Risk drawer — show more + suggestion chips
    document.getElementById('truvala-risk-drawer').addEventListener('click', (e) => {
      const showMore = e.target.closest('.truvala-module-show-more');
      if (showMore) {
        const target = document.getElementById(showMore.dataset.target);
        if (target) {
          const open = target.style.display !== 'none';
          target.style.display = open ? 'none' : '';
          showMore.textContent = open ? 'Show more ›' : 'Show less ‹';
        }
        return;
      }
      const chip = e.target.closest('.truvala-suggestion-chip');
      if (chip) { sendChatMessage(chip.textContent); return; }
    });

    // Chat send button + Enter key
    document.getElementById('truvala-chat-send').addEventListener('click', () => {
      const input = document.getElementById('truvala-chat-input');
      sendChatMessage(input.value);
    });
    document.getElementById('truvala-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(e.target.value);
      }
    });

    // Costs toggle — header button and in-report button both trigger this
    const toggleCosts = () => {
      const existing = document.getElementById('truvala-costs-section');
      if (existing) { existing.remove(); return; }
      if (!currentReport?.monthly_costs) return;
      const section = document.createElement('div');
      section.id = 'truvala-costs-section';
      section.innerHTML = buildCostsHTML(currentReport.monthly_costs, currentReport.ecosolar);
      const costsBtn = document.getElementById('truvala-costs-btn');
      if (costsBtn) {
        costsBtn.after(section);
      } else {
        document.getElementById('truvala-panel-body').prepend(section);
      }
    };

    // Popover close button
    document.getElementById('truvala-popover-close').addEventListener('click', closeFieldPopover);

    // Close popover on outside click
    document.addEventListener('click', (e) => {
      const popover = document.getElementById('truvala-field-popover');
      if (popover && popover.style.display !== 'none' &&
          !popover.contains(e.target) &&
          !e.target.closest('.truvala-breakdown-chip')) {
        closeFieldPopover();
      }
    }, true);

    // In-report button and financing toggle use delegation
    document.getElementById('truvala-panel-body').addEventListener('click', (e) => {
      if (e.target.closest('#truvala-costs-btn')) { toggleCosts(); return; }
      if (e.target.closest('#truvala-full-risk-btn')) { openRiskDrawer(); return; }

      // Score breakdown toggle
      if (e.target.closest('#truvala-breakdown-toggle')) {
        const body = document.getElementById('truvala-breakdown-body');
        const toggle = document.getElementById('truvala-breakdown-toggle');
        const chevron = toggle.querySelector('.truvala-breakdown-main-chevron');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(180deg)';
        toggle.style.borderRadius = open ? '0 0 16px 16px' : '0';
        return;
      }

      // Field row → inline expand
      const fieldRowMain = e.target.closest('.truvala-field-row-main');
      if (fieldRowMain) {
        const row     = fieldRowMain.closest('.truvala-field-row');
        const detail  = row.querySelector('.truvala-field-row-detail');
        const chevron = fieldRowMain.querySelector('.truvala-field-row-chevron');
        const open    = getComputedStyle(detail).display !== 'none';
        detail.style.display = open ? 'none' : 'block';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
        row.classList.toggle('truvala-field-row--open', !open);
        return;
      }

      // Risk module collapse/expand
      const riskBtn = e.target.closest('.truvala-risk-module-btn');
      if (riskBtn) {
        const module = riskBtn.closest('.truvala-risk-module');
        const body   = module.querySelector('.truvala-risk-module-body');
        const chevron = riskBtn.querySelector('.truvala-risk-chevron');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
        return;
      }

      // Collapsible list expand
      const expandBtn = e.target.closest('.truvala-expand-btn[data-target]');
      if (expandBtn) {
        const target = document.getElementById(expandBtn.dataset.target);
        if (target) {
          const open = target.style.display !== 'none';
          target.style.display = open ? 'none' : '';
          expandBtn.textContent = open
            ? `+ ${expandBtn.dataset.more} more ›`
            : 'Show less';
        }
        return;
      }

      if (e.target.closest('#truvala-eco-details-toggle')) {
        const details = document.getElementById('truvala-eco-details');
        const btn = document.getElementById('truvala-eco-details-toggle');
        if (details) {
          const open = details.style.display !== 'none';
          details.style.display = open ? 'none' : 'flex';
          details.style.flexDirection = 'column';
          details.style.gap = '6px';
          btn.querySelector('span:last-child').textContent = open ? '›' : '˅';
          btn.querySelector('span:first-child').textContent = open ? 'View financing details' : 'Hide financing details';
        }
      }
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

    // Reference city + autocomplete
    const refCityInput = document.getElementById('truvala-input-ref-city');
    if (refCityInput) {
      let _cityTimer = null;

      function getCityDropdown() {
        let dd = document.getElementById('truvala-city-dropdown');
        if (!dd) {
          dd = document.createElement('div');
          dd.id = 'truvala-city-dropdown';
          dd.className = 'truvala-city-dropdown';
          refCityInput.parentElement.appendChild(dd);
        }
        return dd;
      }

      function hideCityDropdown() {
        const dd = document.getElementById('truvala-city-dropdown');
        if (dd) dd.style.display = 'none';
      }

      function showCityDropdown(suggestions) {
        const dd = getCityDropdown();
        if (!suggestions.length) { dd.style.display = 'none'; return; }
        dd.innerHTML = suggestions
          .map(s => `<div class="truvala-city-option" data-value="${s.replace(/"/g, '&quot;')}">${s}</div>`)
          .join('');
        dd.style.display = 'block';
        dd.querySelectorAll('.truvala-city-option').forEach(opt => {
          opt.addEventListener('mousedown', (e) => {
            e.preventDefault();
            refCityInput.value = opt.dataset.value;
            currentPrefs.reference_city = opt.dataset.value;
            hideCityDropdown();
          });
        });
      }

      refCityInput.addEventListener('input', () => {
        clearTimeout(_cityTimer);
        const q = refCityInput.value.trim();
        if (q.length < 2) { hideCityDropdown(); return; }
        _cityTimer = setTimeout(async () => {
          const suggestions = await fetchCitySuggestions(q);
          showCityDropdown(suggestions);
        }, 350);
      });

      refCityInput.addEventListener('blur', () => {
        // Delay hide so mousedown on a suggestion fires first
        setTimeout(hideCityDropdown, 150);
        currentPrefs.reference_city = refCityInput.value.trim();
      });

      refCityInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') refCityInput.blur();
        if (e.key === 'Escape') hideCityDropdown();
      });
    }

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
    loadPinnedHomes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
