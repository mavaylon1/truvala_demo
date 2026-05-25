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

  let currentReport   = null;
  let currentAddress  = '';

  // ─── Chat state ───────────────────────────────────────────────────────────────

  let chatMessages       = [];   // [{role, content}] full history sent to backend
  let riskDrawerBuilt    = false; // prevents rebuilding DOM on re-open
  let detailChatMessages = [];   // per-factor detail panel chat history
  let activeDetailKey    = null; // which module is currently open in detail panel
  let activeDetailBullet = null; // which bullet text triggered the current detail session
  const _bulletChatCache = new Map(); // `${moduleKey}||${bulletText}` → { messages, html }

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
    console.log('[Truvala] report received:', JSON.stringify(report, null, 2));
    currentReport   = report;
    currentAddress  = address;
    chatMessages    = [];
    riskDrawerBuilt = false;

    // Keep mini bubble and side-tab score up to date
    const miniScore   = document.getElementById('truvala-mini-score');
    const miniAddress = document.getElementById('truvala-mini-address');
    const miniDisplayScore = getDisplayScore(report.score, report.risk_report);
    miniScore.textContent  = miniDisplayScore;
    miniScore.style.color  = scoreColor(miniDisplayScore);
    miniAddress.textContent = address;

    // Populate panel
    document.getElementById('truvala-address').textContent = address;
    const costsSnippet = buildCostsHTML(report.monthly_costs, report.ecosolar);
    console.log('[Truvala] costsHTML length:', costsSnippet.length, '| first 200:', costsSnippet.slice(0, 200));
    const fullHTML = buildReportHTML(report);
    console.log('[Truvala] fullHTML starts with:', fullHTML.slice(0, 300));
    const panelBody = document.getElementById('truvala-panel-body');
    panelBody.innerHTML = fullHTML;
    panelBody.scrollTop = 0;
    console.log('[Truvala] first child tag:', panelBody.firstElementChild?.tagName, '| style:', panelBody.firstElementChild?.getAttribute('style')?.slice(0, 60));

    // Risk toggle button
    const riskToggleBtn = document.getElementById('truvala-risk-toggle-btn');
    if (riskToggleBtn) {
      riskToggleBtn.addEventListener('click', () => {
        const rawScore  = parseInt(riskToggleBtn.dataset.raw) || 0;
        const fromScore = parseInt(document.getElementById('truvala-score-value')?.textContent) || 0;
        toggleRiskScore();
        const toScore = getDisplayScore(rawScore, currentReport.risk_report);
        animateScoreChange(fromScore, toScore);
        const segs = riskToggleBtn.querySelectorAll('.truvala-toggle-seg');
        if (segs.length === 2) {
          segs[0].classList.toggle('truvala-toggle-active', !_showRiskInScore);
          segs[1].classList.toggle('truvala-toggle-active', _showRiskInScore);
        }
        const miniScoreEl = document.getElementById('truvala-mini-score');
        if (miniScoreEl) { miniScoreEl.textContent = toScore; miniScoreEl.style.color = scoreColor(toScore); }
      });
    }

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

  // ─── Risk-adjusted score ───────────────────────────────────────────────────
  let _showRiskInScore = true;

  function computeRiskPenalty(riskReport) {
    if (!riskReport) return 0;
    let penalty = 0;
    const modules = ['age_era', 'component_lifespan', 'listing_language', 'builder_info', 'maintenance_history', 'neighborhood', 'insurance'];
    for (const key of modules) {
      const mod = riskReport[key];
      if (!mod) continue;
      for (const s of (mod.computed_risk_signals || [])) {
        if (s.startsWith('[High]')) {
          penalty += 6;
          if (/lead paint|asbestos|mold|radon|carbon monoxide/i.test(s)) penalty += 2;
        } else if (s.startsWith('[Medium]')) {
          penalty += 3;
        } else if (s.startsWith('[Low]')) {
          penalty += 1;
        }
      }
    }
    const highGaps = (riskReport.verification_checklist?.checklist || [])
      .filter(i => i.priority === 'High').length;
    penalty += highGaps * 2;
    return Math.min(penalty, 40);
  }

  function getRiskAdjustedScore(rawScore, riskReport) {
    return Math.max(0, rawScore - computeRiskPenalty(riskReport));
  }

  function toggleRiskScore() {
    _showRiskInScore = !_showRiskInScore;
    return _showRiskInScore;
  }

  function getDisplayScore(rawScore, riskReport) {
    return _showRiskInScore ? getRiskAdjustedScore(rawScore, riskReport) : rawScore;
  }

  function animateScoreChange(fromScore, toScore) {
    const ringWrap = document.getElementById('truvala-score-ring-wrap');
    const valueEl  = document.getElementById('truvala-score-value');
    if (!ringWrap || !valueEl) return;
    const r = 15, circ = 2 * Math.PI * r;
    const activeCircle = ringWrap.querySelectorAll('circle')[1];
    const scoreText    = ringWrap.querySelectorAll('text')[0];
    const duration = 500;
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      const current = Math.round(fromScore + (toScore - fromScore) * eased);
      const color = scoreColor(current);
      const dash = ((current / 100) * circ).toFixed(2);
      const gap  = (circ - parseFloat(dash)).toFixed(2);
      if (activeCircle) {
        activeCircle.setAttribute('stroke-dasharray', `${dash} ${gap}`);
        activeCircle.setAttribute('stroke', color);
      }
      if (scoreText) { scoreText.textContent = current; scoreText.setAttribute('fill', color); }
      valueEl.textContent = current;
      valueEl.style.color = color;
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  // ──────────────────────────────────────────────────────────────────────────

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
    const title  = css({ fontSize: '11px', fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.07em', padding: '14px 16px 8px', display: 'block' });
    const rows   = css({ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: '7px' });
    const rowS   = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    const lbl    = css({ fontSize: '12.5px', color: '#475569' });
    const val    = css({ fontSize: '12.5px', fontWeight: '600', color: '#1e293b' });
    const bold   = css({ fontSize: '13px', fontWeight: '700', color: '#0f172a' });
    const hr     = `<div style="height:1px;background:rgba(226,232,240,0.9);margin:4px 0"></div>`;
    const grn    = css({ fontSize: '12.5px', fontWeight: '600', color: '#059669' });
    const red    = css({ fontSize: '12.5px', fontWeight: '600', color: '#dc2626' });
    const note   = css({ fontSize: '11px', color: '#94a3b8', lineHeight: '1.5', padding: '8px 16px 12px', borderTop: '1px solid rgba(226,232,240,0.6)' });

    const row = (l, v, vStyle = val) =>
      `<div style="${rowS}"><span style="${lbl}">${l}</span><span style="${vStyle}">${v}</span></div>`;

    let costRows = row(`Mortgage (${assumptions.down_payment_pct * 100}% down, ${rate}% APR)`, `${fmt(mortgage)}/mo`);
    costRows += row('Property Tax', `${fmt(property_tax)}/mo`);
    costRows += row('HOA', `${fmt(hoa)}/mo`);
    if (hoa_note) costRows += `<div style="font-size:11px;color:#d97706;margin-top:-4px">⚠ ${hoa_note}</div>`;
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
      const heroNum   = css({ fontSize: '28px', fontWeight: '700', color: '#059669', lineHeight: '1', letterSpacing: '-0.03em' });
      const heroSub   = css({ fontSize: '12px', color: '#047857', marginTop: '2px' });
      const heroCap   = css({ fontSize: '11px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' });

      const detailToggle = css({ width: '100%', padding: '9px 16px', background: 'none', border: 'none', borderTop: '1px solid rgba(226,232,240,0.7)', color: '#64748b', fontSize: '12px', fontWeight: '500', cursor: 'pointer', textAlign: 'left', fontFamily: '-apple-system,sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const detailRows  = css({ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: '6px' });

      ecoHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-top:1px solid rgba(226,232,240,0.9)">
          <img src="${logo_url}" alt="EcoSolar USA" style="height:26px;width:auto;object-fit:contain">
          <span style="font-size:10px;font-weight:600;color:#059669;background:#d1fae5;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em">Partner</span>
        </div>

        <div style="${heroStyle}">
          <div style="${heroCap}">After panels paid off (est. ${estimated_payoff_years} yrs)</div>
          <div style="${heroNum}">${fmt(monthlySavedAfter)}<span style="font-size:14px;font-weight:500">/mo saved</span></div>
          <div style="${heroSub}">New monthly total: ${fmt(afterPayoffTotal)}/mo · Down from ${fmt(total)}/mo</div>
        </div>

        ${chart ? `<div style="padding:14px 16px 8px">
          <div style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Cumulative Savings Over Time</div>
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
    const colors = ['#10b981', '#fb923c', '#ef4444'];
    const r = (risk || '').toLowerCase();
    const idx = r.includes('high') ? 2 : r.includes('low') && !r.includes('high') ? 0 : 1;
    return `
      <div style="margin-top:8px">
        <div style="display:flex;gap:3px;height:6px;border-radius:3px;overflow:hidden">
          ${levels.map((_, i) => `<div style="flex:1;background:${i <= idx ? colors[idx] : '#e2e8f0'};opacity:${i === idx ? 1 : i < idx ? 0.4 : 0.2}"></div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          ${levels.map(l => `<span style="font-size:9px;color:#94a3b8">${l}</span>`).join('')}
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
    if (signal.startsWith('[Medium]')) return { color: '#fb923c', label: 'Medium', text: signal.replace('[Medium] ', '') };
    if (signal.startsWith('[Low]'))    return { color: '#10b981', label: 'Low',    text: signal.replace('[Low] ', '') };
    return { color: '#94a3b8', label: null, text: signal };
  }

  // Words that add zero label value — kept tight so adjectives survive
  const _STOP = new Set([
    // Pure grammar
    'or','and','the','a','an','is','are','was','were','to','of','for','with',
    'in','at','by','on','from','that','this','it','may','can','be','as','if',
    'but','so','do','has','have','had','will','would','could','should','been',
    'being','its','their','they','we','you','he','she','both','either',
    'neither','than','then','when','where','which','who',
    'per','via','due','any','all','yet','still','well','just','also','very',
    'more','most','often','typically','commonly','usually','over','under',
    // User-specified: age/time words
    'year','years','age','aged','date','dates','decade','decades','period',
    'estimated','estimate','approximately','era','time','old','new','recent',
    // Generic property nouns (every module says "home/property/listing")
    'home','house','property','listing','building','structure','residence',
    // Pure process verbs with no label value
    'include','includes','suggest','suggests','show','shows',
    'appear','appears','indicate','indicates',
  ]);

  // Absolute minimum stop — used only in the 2-word fallback
  const _HARD_STOP = new Set([
    'or','and','the','a','an','is','to','of','for','with','in','at','by','on',
    'from','that','this','it','but','be','as','so',
  ]);

  function formatBullet(text) {
    const words = text.split(/\s+/).filter(Boolean);
    const filtered = words.filter(w => {
      const bare = w.toLowerCase().replace(/[^a-z0-9\-]/g, '');
      return bare.length > 1 && !/^\d+$/.test(bare) && !_STOP.has(bare);
    });
    let pool = filtered;
    // If fewer than 2 words survived, loosen to hard-stop-only filtering
    if (pool.length < 2) {
      pool = words.filter(w => {
        const bare = w.toLowerCase().replace(/[^a-z0-9\-]/g, '');
        return bare.length > 1 && !/^\d+$/.test(bare) && !_HARD_STOP.has(bare);
      });
    }
    const out = pool.slice(0, 3).join(' ').replace(/[\s.,;:!\?\-–—]+$/, '');
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
  }

  // Keep alias so callers don't need changing
  const truncateBullet = formatBullet;

  function signalRankScore(signal) {
    const t = signal.toLowerCase();
    let score = 0;
    if (signal.startsWith('[High]'))   score += 300;
    else if (signal.startsWith('[Medium]')) score += 150;
    else if (signal.startsWith('[Low]'))    score += 50;
    // Health hazard bonus
    if (/lead paint|asbestos|mold|carbon monoxide|radon|legionella/.test(t)) score += 100;
    if (/fire risk|electrical fire|flood zone|knob.and.tube/.test(t)) score += 60;
    // Cost bonus
    if (/roof|foundation|sewer|rewir/.test(t)) score += 50;
    if (/hvac|electrical panel|replac/.test(t)) score += 40;
    if (/plumbing|water heater/.test(t)) score += 20;
    return score;
  }

  // Multi-factor color: health hazard takes priority over severity label
  function bulletColor(rawSignal) {
    const t = rawSignal.toLowerCase();
    if (rawSignal.startsWith('[Low]')) return '#10b981';
    if (/lead paint|asbestos|mold|carbon monoxide|radon|legionella|toxic|electrical fire|fire risk|knob.and.tube|flood zone/.test(t)) return '#fb923c';
    if (rawSignal.startsWith('[High]') || rawSignal.startsWith('[Medium]')) return '#fb923c';
    return '#94a3b8';
  }

  // Strip boilerplate and reduce to the core claim (before any em-dash explanation)
  function cleanBulletText(text) {
    let t = text
      // Known boilerplate prefixes
      .replace(/^Home is \d+\s*years?\s*old\s*[—–\-]+\s*/i, '')
      .replace(/^Built in \d{4}\s*[—–\-]+\s*/i, '')
      .replace(/^Listing (references?|states?|mentions?|uses? language associated with )\s*/i, '')
      .replace(/\s*—\s*approximately \d+ years of maintenance history/i, '')
      // Take only the part before the em-dash — explanation lives after it
      .replace(/\s*[—–]\s*.+$/, '')
      // Strip colons entirely
      .replace(/:/g, ' ')
      // Strip unfinished parenthetical (open paren with no close)
      .replace(/\s*\([^)]*$/, '')
      // Strip trailing punctuation
      .replace(/[\s.,;!\?\-–—]+$/, '');
    return t.trim();
  }

  // Icon for common bullet signal types
  function getBulletIcon(text) {
    const t = text.toLowerCase();
    if (/lead paint|asbestos|mold|radon|carbon monoxide|legionella/.test(t)) return '☣';
    if (/flood|water damage|moisture|wet basement/.test(t)) return '💧';
    if (/electrical|knob.and.tube|wiring|circuit|panel/.test(t)) return '⚡';
    if (/roof|shingle/.test(t)) return '🏠';
    if (/foundation|structural|settlement|slab/.test(t)) return '🏗';
    if (/hvac|furnace|heating|cooling|air condition/.test(t)) return '🌡';
    if (/plumbing|sewer|pipe|water heater/.test(t)) return '🔧';
    if (/unpermit|permit|code violation/.test(t)) return '📋';
    if (/as.is|deferred|handyman|fixer|tlc/.test(t)) return '🔨';
    if (/warranty|builder warranty/.test(t)) return '📜';
    if (/missing|not disclosed|unknown|cannot confirm/.test(t)) return '❓';
    return '';
  }

  function contentNouns(text) {
    return text.split(/\s+/)
      .map(w => w.toLowerCase().replace(/[^a-z0-9\-]/g, ''))
      .filter(b => b.length > 3 && !/^\d+$/.test(b) && !_STOP.has(b));
  }

  function getTopBullets(module) {
    const result = [];
    const seenKeys  = new Set(); // full-text dedup
    const usedNouns = new Set(); // cross-bullet noun dedup within tab

    const add = (fullText, color) => {
      const key = fullText.toLowerCase().slice(0, 50);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const displayText = cleanBulletText(fullText);
      const nouns = contentNouns(displayText);

      // Skip bullet if ANY of its nouns already appeared in this tab
      if (nouns.some(n => usedNouns.has(n))) return;

      // Register all nouns so no later bullet can repeat them
      nouns.forEach(n => usedNouns.add(n));

      result.push({ displayText, fullText, color, icon: getBulletIcon(fullText) });
    };

    const ranked = (module.computed_risk_signals || [])
      .map(s => ({ s, score: signalRankScore(s) }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.s);

    for (const s of ranked) {
      if (result.length >= 5) break;
      const { text } = signalSeverity(s);
      // Skip signals that are purely "Home is X years old —" — produce nothing useful at 3 words
      if (/^Home is \d+\s*years?\s*old\b/i.test(text)) continue;
      add(text, bulletColor(s));
    }
    for (const c of (module.inferred_concerns || [])) {
      if (result.length >= 5 || result.length >= 3) break;
      add(c, bulletColor(c));
    }
    for (const f of (module.observed_facts || [])) {
      if (result.length >= 5 || result.length >= 3) break;
      if (/^Built in \d{4}$/.test(f.trim())) continue;
      if (/^Home is approximately \d+ years old$/.test(f.trim())) continue;
      add(f, '#64748b');
    }
    return result;
  }

  function buildCompactModuleHTML(module, key) {
    if (!module) return '';
    const signals = module.computed_risk_signals || [];
    const bullets = getTopBullets(module);
    const icon = MODULE_ICONS[key] || '';
    const badge = signals.length
      ? `<span class="truvala-module-badge truvala-badge-warn">${signals.length} signal${signals.length !== 1 ? 's' : ''}</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ Clear</span>`;
    const sectionLabel = module.section.replace(/\s+risk$/i, '').trim();
    const bulletsHTML = bullets.length
      ? bullets.map(b => {
          const safe = b.fullText.replace(/"/g, '&quot;');
          const iconSpan = b.icon ? `<span class="truvala-bullet-icon">${b.icon}</span>` : '';
          return `
          <div class="truvala-compact-bullet" data-module-key="${key}" data-bullet-text="${safe}">
            <span class="truvala-bullet-dot" style="background:${b.color}"></span>
            ${iconSpan}<span class="truvala-bullet-text">${truncateBullet(b.displayText)}</span>
            <span class="truvala-bullet-history-icon" style="display:none"><svg width="15" height="15" viewBox="0 0 24 24" fill="#3b82f6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          </div>`;
        }).join('')
      : `<div class="truvala-compact-bullet"><span style="color:#94a3b8;font-style:italic">No signals detected</span></div>`;
    return `
      <div class="truvala-risk-module" data-module-key="${key}">
        <button class="truvala-risk-module-btn" data-module-key="${key}">
          <span class="truvala-risk-module-title"><span class="truvala-tab-icon">${icon}</span>${sectionLabel}</span>
          <div class="truvala-risk-module-right">${badge}<span class="truvala-risk-chevron">›</span></div>
        </button>
        <div class="truvala-risk-module-body" style="display:none">
          ${bulletsHTML}
        </div>
      </div>`;
  }

  function buildCompactChecklistHTML(checklist) {
    if (!checklist) return '';
    const items  = checklist.checklist || [];
    const high   = items.filter(i => i.priority === 'High');
    const medium = items.filter(i => i.priority === 'Medium');
    const bullets = [];
    for (const i of high)   { bullets.push({ text: i.item, color: '#ef4444' }); if (bullets.length >= 5) break; }
    if (bullets.length < 3) {
      for (const i of medium) { bullets.push({ text: i.item, color: '#fb923c' }); if (bullets.length >= 5) break; }
    }
    const icon = MODULE_ICONS['verify'] || '';
    const badge = high.length
      ? `<span class="truvala-module-badge truvala-badge-warn">${high.length} high priority</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ No gaps</span>`;
    const bulletsHTML = bullets.length
      ? bullets.map(b => {
          const safe = b.text.replace(/"/g, '&quot;');
          const bIcon = getBulletIcon(b.text);
          const iconSpan = bIcon ? `<span class="truvala-bullet-icon">${bIcon}</span>` : '';
          return `
          <div class="truvala-compact-bullet" data-module-key="verify" data-bullet-text="${safe}">
            <span class="truvala-bullet-dot" style="background:${b.color}"></span>
            ${iconSpan}<span class="truvala-bullet-text">${truncateBullet(b.text)}</span>
            <span class="truvala-bullet-history-icon" style="display:none"><svg width="15" height="15" viewBox="0 0 24 24" fill="#3b82f6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          </div>`;
        }).join('')
      : `<div class="truvala-compact-bullet"><span style="color:#94a3b8;font-style:italic">No priority gaps found</span></div>`;
    return `
      <div class="truvala-risk-module" data-module-key="verify">
        <button class="truvala-risk-module-btn" data-module-key="verify">
          <span class="truvala-risk-module-title"><span class="truvala-tab-icon">${icon}</span>${checklist.section}</span>
          <div class="truvala-risk-module-right">${badge}<span class="truvala-risk-chevron">›</span></div>
        </button>
        <div class="truvala-risk-module-body" style="display:none">
          ${bulletsHTML}
        </div>
      </div>`;
  }


  // ─── 5-Tab Risk Report Builders ──────────────────────────────────────────────

  function buildTabHTML(key, label, icon, badge, bullets) {
    const bulletsHTML = bullets.length
      ? bullets.map(b => {
          const safe = (b.fullText || b.display).replace(/"/g, '&quot;');
          const emojiSpan = b.emoji ? `<span class="truvala-bullet-icon">${b.emoji}</span>` : '';
          return `
          <div class="truvala-compact-bullet" data-module-key="${key}" data-bullet-text="${safe}">
            <span class="truvala-bullet-dot" style="background:${b.color}"></span>
            ${emojiSpan}<span class="truvala-bullet-text">${b.display}</span>
            <span class="truvala-bullet-history-icon" style="display:none"><svg width="15" height="15" viewBox="0 0 24 24" fill="#3b82f6"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          </div>`;
        }).join('')
      : `<div class="truvala-compact-bullet"><span style="color:#94a3b8;font-style:italic">No signals detected</span></div>`;
    return `
      <div class="truvala-risk-module" data-module-key="${key}">
        <button class="truvala-risk-module-btn" data-module-key="${key}">
          <span class="truvala-risk-module-title"><span class="truvala-tab-icon">${icon}</span>${label}</span>
          <div class="truvala-risk-module-right">${badge}<span class="truvala-risk-chevron">›</span></div>
        </button>
        <div class="truvala-risk-module-body" style="display:none">
          ${bulletsHTML}
        </div>
      </div>`;
  }

  const _HEALTH_RE = /lead|asbestos|mold|mould|moisture|water.damage|water.intrusion|radon|carbon.monoxide|knob.and.tube|knob-and-tube|aluminum.wir|polybutylene|chinese.drywall|flood.zone|floodplain/i;

  function healthBulletLabel(text) {
    const t = text.toLowerCase();
    if (/lead\s*paint|lead-based/.test(t))            return 'Lead Paint Hazard';
    if (/asbestos/.test(t))                           return 'Asbestos Materials';
    if (/knob.and.tube|knob-and-tube/.test(t))        return 'Knob-and-Tube Wiring';
    if (/aluminum.wir/.test(t))                       return 'Aluminum Wiring';
    if (/polybutylene/.test(t))                       return 'Polybutylene Plumbing';
    if (/chinese.drywall/.test(t))                    return 'Chinese Drywall';
    if (/mold|mould/.test(t))                         return 'Mold & Moisture';
    if (/moisture|water.damage|water.intrusion/.test(t)) return 'Water Intrusion';
    if (/flood/.test(t))                              return 'Flood Zone';
    if (/radon/.test(t))                              return 'Radon Exposure';
    if (/carbon.monoxide/.test(t))                    return 'Carbon Monoxide';
    return text.replace(/^\[(High|Medium|Low)\]\s*/i, '').split(/\s*[—–]\s*/)[0].trim();
  }

  function healthBulletEmoji(text) {
    const t = text.toLowerCase();
    if (/lead/.test(t))                      return '🎨';
    if (/asbestos/.test(t))                  return '⚠️';
    if (/knob.and.tube|aluminum.wir/.test(t)) return '⚡';
    if (/mold|mould|moisture|water/.test(t)) return '💧';
    if (/flood/.test(t))                     return '🌊';
    if (/radon/.test(t))                     return '☢️';
    if (/carbon.monoxide/.test(t))           return '💨';
    if (/polybutylene/.test(t))              return '🔧';
    if (/chinese.drywall/.test(t))           return '🏗️';
    return '⚠️';
  }

  function buildHealthTab(rr) {
    const bullets = [];
    for (const s of (rr.age_era?.computed_risk_signals || [])) {
      if (_HEALTH_RE.test(s) && bullets.length < 4) {
        bullets.push({ display: healthBulletLabel(s), fullText: s, color: '#fb923c', emoji: healthBulletEmoji(s) });
      }
    }
    for (const s of (rr.listing_language?.computed_risk_signals || [])) {
      if (/mold|mould|moisture|water.damage|water.intrusion|flood/i.test(s) && bullets.length < 4) {
        bullets.push({ display: healthBulletLabel(s), fullText: s, color: '#fb923c', emoji: healthBulletEmoji(s) });
      }
    }
    if (!bullets.length) {
      bullets.push({ display: 'No Health Hazards', fullText: 'No health hazard signals detected for this property', color: '#10b981', emoji: '✅' });
    }
    const warnCount = bullets.filter(b => b.color === '#fb923c').length;
    const badge = warnCount
      ? `<span class="truvala-module-badge truvala-badge-warn">${warnCount} signal${warnCount !== 1 ? 's' : ''}</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ Clear</span>`;
    return buildTabHTML('health', 'Health', MODULE_ICONS['health'], badge, bullets);
  }

  const _COMPONENT_DEFS = [
    { backendName: 'Roof',             display: 'Roof',         emoji: '🏠' },
    { backendName: 'Water Heater',     display: 'Water Heater', emoji: '🚿' },
    { backendName: 'Plumbing',         display: 'Plumbing',     emoji: '🔧' },
    { backendName: 'HVAC',             display: 'HVAC',         emoji: '❄️' },
    { backendName: 'Electrical Panel', display: 'Electrical',   emoji: '⚡' },
    { backendName: 'Foundation',       display: 'Foundation',   emoji: '🏛️' },
  ];

  function buildComponentTab(rr) {
    const signals = rr.component_lifespan?.computed_risk_signals || [];
    const facts   = rr.component_lifespan?.observed_facts || [];
    const bullets = _COMPONENT_DEFS.map(({ backendName, display, emoji }) => {
      const nameLower = backendName.toLowerCase();
      const signal = signals.find(s => s.toLowerCase().startsWith(nameLower + ':'));
      const fact   = facts.find(f => f.toLowerCase().startsWith(nameLower + ':'));
      let color = '#94a3b8';
      let fullText = `${backendName}: age and condition unverified`;
      if (signal) {
        fullText = signal;
        color = /age unknown/i.test(signal) ? '#94a3b8' : '#fb923c';
      } else if (fact) {
        fullText = fact;
        color = /within typical lifespan|recent update|replaced/i.test(fact) ? '#10b981' : '#94a3b8';
      }
      return { display, fullText, color, emoji };
    });
    const warnCount = bullets.filter(b => b.color === '#fb923c').length;
    const badge = warnCount
      ? `<span class="truvala-module-badge truvala-badge-warn">${warnCount} component${warnCount !== 1 ? 's' : ''} flagged</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ All clear</span>`;
    return buildTabHTML('component_lifespan', 'Component Lifespan', MODULE_ICONS['component_lifespan'], badge, bullets);
  }

  function buildNeighborhoodTab(rr, listing) {
    const city = listing.city || listing.address || '';
    const signals = rr.neighborhood?.computed_risk_signals || [];
    const bullets = [
      { display: 'Crime Rate',        fullText: signals[0] || `Crime Rate — ${city || 'area'} town safety statistics`, color: '#94a3b8', emoji: '🚨' },
      { display: 'Traffic & Commute', fullText: signals[1] || `Traffic & Commute — highways and commute times near ${city || 'this area'}`, color: '#94a3b8', emoji: '🚗' },
    ];
    const badge = `<span class="truvala-module-badge truvala-badge-warn">Research needed</span>`;
    return buildTabHTML('neighborhood', 'Neighborhood', MODULE_ICONS['neighborhood'], badge, bullets);
  }

  function buildLanguageTab(rr) {
    const signals = rr.listing_language?.computed_risk_signals || [];
    const hasRisk = signals.length > 0;
    const allText = hasRisk ? signals.join('; ') : 'No high-risk language in listing';
    const bullet  = { display: 'High-risk Language', fullText: allText, color: hasRisk ? '#fb923c' : '#10b981', emoji: '🚩' };
    const badge   = hasRisk
      ? `<span class="truvala-module-badge truvala-badge-warn">${signals.length} flag${signals.length !== 1 ? 's' : ''}</span>`
      : `<span class="truvala-module-badge truvala-badge-clear">✓ Clear</span>`;
    return buildTabHTML('language', 'Language', MODULE_ICONS['language'], badge, [bullet]);
  }

  function buildInsuranceTab(rr, listing) {
    const state   = listing.state || '';
    const signals = rr.insurance?.computed_risk_signals || [];
    const disasterColor  = signals[0] && /flag detected|reference detected/i.test(signals[0]) ? '#fb923c' : '#94a3b8';
    const coverageColor  = signals[1] && /high hurricane|wildfire|flood risk|limited|exited|stopped writing/i.test(signals[1]) ? '#fb923c' : '#94a3b8';
    const leaseColor     = signals[2] && /land lease detected|lease detected/i.test(signals[2]) ? '#fb923c' : '#94a3b8';
    const bullets = [
      { display: 'Natural Disaster History', fullText: signals[0] || `Natural disaster exposure — flood, wildfire, storm${state ? ' in ' + state : ''}`, color: disasterColor, emoji: '🌪️' },
      { display: 'Insurance Availability',   fullText: signals[1] || `Insurance coverage — state policies and premiums${state ? ' in ' + state : ''}`,     color: coverageColor, emoji: '🛡️' },
      { display: 'Land Lease',               fullText: signals[2] || 'Land Lease — own land or pay ground rent',                                            color: leaseColor,   emoji: '📋' },
    ];
    const warnCount = bullets.filter(b => b.color === '#fb923c').length;
    const badge = warnCount
      ? `<span class="truvala-module-badge truvala-badge-warn">${warnCount} concern${warnCount !== 1 ? 's' : ''}</span>`
      : `<span class="truvala-module-badge truvala-badge-warn">Research needed</span>`;
    return buildTabHTML('insurance', 'Insurance', MODULE_ICONS['insurance'], badge, bullets);
  }

  // ─────────────────────────────────────────────────────────────────────────────

  function buildReportHTML(report) {
    const displayScore = getDisplayScore(report.score, report.risk_report);
    const fieldChips = Object.entries(report.field_scores).map(([key, f]) => {
      const pct = Math.round(f.utility * 100);
      const color = fieldBarColor(f.utility);
      return `
        <button class="truvala-breakdown-chip" data-field-key="${key}">
          <div class="truvala-breakdown-chip-top">
            <span class="truvala-breakdown-chip-name">${f.label}</span>
            <span class="truvala-breakdown-chip-pct" style="color:${color}">${pct}%</span>
          </div>
          <div class="truvala-field-bar-track" style="margin-top:5px">
            <div class="truvala-field-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
        </button>`;
    }).join('');

    const summaryHTML = `<p class="truvala-summary-text">${report.summary}</p>`;

    return `
      <div class="truvala-score-card">
        <div class="truvala-score-section">
          <div class="truvala-score-ring-wrap" id="truvala-score-ring-wrap">${buildScoreRing(displayScore)}</div>
          <div class="truvala-score-meta">
            <div class="truvala-score-label">Buyer Fit Score</div>
            <div class="truvala-score-value" id="truvala-score-value" style="color:${scoreColor(displayScore)}">${displayScore}</div>
            <button class="truvala-risk-toggle-pill" id="truvala-risk-toggle-btn" data-raw="${report.score}">
              <span class="truvala-toggle-seg${!_showRiskInScore ? ' truvala-toggle-active' : ''}">Before</span>
              <span class="truvala-toggle-div">|</span>
              <span class="truvala-toggle-seg${_showRiskInScore ? ' truvala-toggle-active' : ''}">After risk</span>
            </button>
            <span class="truvala-risk-badge ${riskClass(report.risk)}">${report.risk} risk</span>
            ${buildRiskGauge(report.risk)}
            <div class="truvala-capex-row" style="margin-top:4px">Est. capex: <strong>${report.capex_estimate}</strong></div>
          </div>
        </div>
        <button class="truvala-breakdown-toggle" id="truvala-breakdown-toggle">
          <span>Score breakdown</span>
          <span class="truvala-breakdown-main-chevron">▾</span>
        </button>
        <div id="truvala-breakdown-body" style="display:none">
          <div class="truvala-breakdown-grid" id="truvala-breakdown-grid">
            ${fieldChips}
          </div>
        </div>
      </div>

      ${report.monthly_costs ? `
      <button id="truvala-costs-btn" style="width:100%;padding:13px 18px;border-radius:12px;border:none;background:#1e3a8a;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,sans-serif;box-shadow:0 4px 14px rgba(30,58,138,0.3);letter-spacing:-0.01em">
        <span>Monthly Costs &amp; Savings</span>
        <span style="font-size:18px;opacity:0.7">›</span>
      </button>` : ''}

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#eff6ff;color:#1e3a8a">✦</span>
          Summary
        </div>
        ${summaryHTML}
      </div>

      ${buildCompactRiskHTML(report)}

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#d1fae5;color:#047857">✓</span>
          What works for you
        </div>
        <ul class="truvala-list">
          ${(report.positives || []).map(text => `
            <li class="truvala-list-item">
              <span class="truvala-list-dot positive">✓</span>
              <span>${text}</span>
            </li>`).join('')}
        </ul>
      </div>`;
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
    return { low: '#10b981', medium: '#fb923c', high: '#ef4444' }[level] || '#94a3b8';
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
            Analysis
          </div>
          <span class="truvala-risk-badge ${riskClass(report.risk)}">${report.risk}</span>
        </div>
        ${levels ? `
          <div class="truvala-risk-cat-grid">
            ${levels.map(buildCategoryCard).join('')}
          </div>` : `
          <p class="truvala-risk-cat-empty">Data not available for this listing.</p>`}
      </div>
      <button id="truvala-full-risk-btn" style="width:100%;padding:13px 18px;border-radius:12px;border:none;background:#1e3a8a;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,sans-serif;box-shadow:0 4px 14px rgba(30,58,138,0.3);letter-spacing:-0.01em">
        <span>Full Report</span>
        <span style="font-size:18px;opacity:0.7">›</span>
      </button>`;
  }

  function buildFullRiskHTML(report) {
    const rr = report.risk_report;
    if (!rr) return '<p class="truvala-drawer-empty">Risk data not available for this listing.</p>';
    const listing = report.listing || {};
    return `
      ${buildHealthTab(rr)}
      ${buildComponentTab(rr)}
      ${buildNeighborhoodTab(rr, listing)}
      ${buildLanguageTab(rr)}
      ${buildInsuranceTab(rr, listing)}`;
  }

  function openRiskDrawer() {
    if (!currentReport) return;
    if (!riskDrawerBuilt) {
      document.getElementById('truvala-drawer-modules').innerHTML = buildFullRiskHTML(currentReport);
      riskDrawerBuilt = true;
    }
    document.getElementById('truvala-risk-drawer').classList.add('truvala-visible');
  }

  function closeRiskDrawer() {
    document.getElementById('truvala-risk-drawer').classList.remove('truvala-visible');
    closeRiskDetailPanel();
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

  // ─── Risk detail panel (per-factor Ask Truvala) ──────────────────────────────

  const MODULE_LABELS = {
    health:              'Health',
    component_lifespan:  'Component Lifespan',
    neighborhood:        'Neighborhood',
    language:            'Language',
    insurance:           'Insurance',
    // Legacy keys (still in risk_report from backend)
    age_era:             'Age & Era',
    listing_language:    'Listing Language',
    verify:              'Missing Info & Verification',
    builder_info:        'Builder & Developer',
    maintenance_history: 'Maintenance & Permit History',
  };

  const MODULE_ICONS = {
    health:              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    component_lifespan:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
    neighborhood:        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    language:            `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    insurance:           `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    // Legacy
    age_era:             `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    listing_language:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    verify:              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    builder_info:        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    maintenance_history: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  };

  const MODULE_SOURCES = {
    health: [
      'epa.gov/lead/renovation-repair-painting-program',
      'epa.gov/asbestos/asbestos-your-home',
      'epa.gov/mold/mold-and-your-health',
      'cdc.gov/niosh/topics/indoorenv',
      'niehs.nih.gov/health/topics/agents',
    ],
    component_lifespan: [
      'nahb.org/how-long-do-products-last-chart',
      'energystar.gov/products/central_air_conditioner',
      'nrca.net/rf/service/warranty-basics',
      'nachi.org/component-lifespans.htm',
    ],
    neighborhood: [
      'city-data.com',
      'areavibes.com',
      'crimemapping.com',
      'spotcrime.com',
      'commutesolutions.org',
    ],
    language: [
      'realtor.com/advice/buy/red-flag-listing-phrases',
      'nolo.com/legal-encyclopedia/warning-signs-home-purchase',
      'consumerfinance.gov/ask-cfpb/home-buying',
      'hud.gov/buyer/process',
    ],
    insurance: [
      'fema.gov/national-flood-insurance-program',
      'floodsmart.gov',
      'iii.org/article/homeowners-insurance-basics',
      'naic.org/index_consumer.htm',
      'disasterassistance.gov',
    ],
    // Legacy keys
    age_era: [
      'epa.gov/lead/renovation-repair-painting-program',
      'hud.gov/program_offices/healthy_homes/lead',
      'epa.gov/asbestos/asbestos-your-home',
      'nachi.org/historic-home-inspection.htm',
    ],
    listing_language: [
      'realtor.com/advice/buy/red-flag-listing-phrases',
      'nolo.com/legal-encyclopedia/warning-signs-home-purchase',
      'consumerfinance.gov/ask-cfpb/home-buying',
      'hud.gov/buyer/process',
    ],
    verify: [
      'consumerfinance.gov/owning-a-home/closing-disclosure',
      'hud.gov/buyer/process/inspection-checklist',
      'nachi.org/inspection-agreement.htm',
      'nahb.org/advocacy/new-home-buyer-checklist',
    ],
    builder_info: [
      'bbb.org/search',
      'buildzoom.com/contractor-license-lookup',
      'consumeraffairs.com/homebuilders',
      'houzz.com/professionals/general-contractors',
      'newhomesource.com/builder-reviews',
    ],
    maintenance_history: [
      'permitdata.org',
      'publicrecords.com/property-records',
      'clrsearch.com/Property_Records',
      'nachi.org/home-inspection-checklist.htm',
      'homeinspector.org/homebuyers',
    ],
  };

  // Keyword → specific sources (checked before module-level fallback)
  const _BULLET_SOURCE_MAP = [
    { re: /lead\s*paint|lead-based/,                sources: ['epa.gov/lead/renovation-repair-painting-program', 'hud.gov/program_offices/healthy_homes/lead', 'epa.gov/lead/homebuyers', 'nachi.org/lead.htm'] },
    { re: /asbestos/,                               sources: ['epa.gov/asbestos/asbestos-your-home', 'osha.gov/asbestos/homeowners', 'nachi.org/asbestos.htm', 'niehs.nih.gov/health/topics/agents/asbestos'] },
    { re: /mold|mould/,                             sources: ['epa.gov/mold/mold-and-your-health', 'cdc.gov/mold', 'nachi.org/mold-inspection.htm', 'iicrc.org/standards'] },
    { re: /radon/,                                  sources: ['epa.gov/radon/consumers-guide-radon-reduction', 'cancer.org/cancer/cancer-causes/radiation-exposure/radon', 'aarst.org/consumer-resources', 'nachi.org/radon.htm'] },
    { re: /electrical|wiring|knob.and.tube|panel|circuit breaker/, sources: ['esfi.org/home', 'nachi.org/electrical-inspection.htm', 'nfpa.org/codes/nec', 'energystar.gov/products/electrical_panels'] },
    { re: /roof|shingle|flashing|gutter/,           sources: ['nrca.net/rf/service/warranty-basics', 'nachi.org/roofing.htm', 'energystar.gov/products/roof_products', 'homeinspector.org/homebuyers'] },
    { re: /hvac|furnace|heat|cooling|air.condition/, sources: ['energystar.gov/products/central_air_conditioner', 'acca.org/homeowners', 'nachi.org/hvac.htm', 'energy.gov/energysaver/heat-and-cool'] },
    { re: /water\s*heat/,                           sources: ['energystar.gov/products/water_heaters', 'energy.gov/energysaver/water-heating', 'nachi.org/water-heater-inspection.htm', 'acca.org/homeowners'] },
    { re: /plumbing|pipe|sewer|drain|water\s*main/, sources: ['nachi.org/plumbing-inspection.htm', 'epa.gov/watersense', 'hud.gov/topics/improvement', 'nsf.org/certified-products'] },
    { re: /foundation|structural|settlement|slab|crawl/, sources: ['nachi.org/foundation.htm', 'nahb.org', 'hud.gov/program_offices/housing/rmra/mts', 'consumerfinance.gov/owning-a-home'] },
    { re: /flood|water.damage|moisture|wet\s*base|basement/, sources: ['fema.gov/national-flood-insurance-program', 'floodsmart.gov', 'nachi.org/water-intrusion.htm', 'epa.gov/mold/mold-and-your-health'] },
    { re: /window|insulation|energy.effic/,         sources: ['energystar.gov/products/windows_doors', 'energy.gov/energysaver/design/windows-doors-and-skylights', 'nachi.org/windows.htm', 'nahb.org'] },
    { re: /permit|unpermit|code.violation/,         sources: ['permitdata.org', 'nachi.org/permits.htm', 'hud.gov/topics/improvement', 'nolo.com/legal-encyclopedia/warning-signs-home-purchase'] },
    { re: /as.is|deferred|fixer|handyman|tlc/,      sources: ['nolo.com/legal-encyclopedia/warning-signs-home-purchase', 'consumerfinance.gov/ask-cfpb/home-buying', 'nachi.org/inspection-agreement.htm', 'hud.gov/buyer/process'] },
    { re: /warranty|builder|developer/,             sources: ['bbb.org/search', 'consumeraffairs.com/homebuilders', 'newhomesource.com/builder-reviews', 'nachi.org/new-construction.htm'] },
    { re: /applianc|dishwasher|refrigerator|oven|washer|dryer/, sources: ['energystar.gov/products/appliances', 'nahb.org/how-long-do-products-last-chart', 'nachi.org/component-lifespans.htm', 'consumerreports.org'] },
  ];

  function getBulletSources(moduleKey, bulletText, addr, addrQ) {
    if (addr && moduleKey === 'builder_info') return [
      `propertyshark.com/mason/?address=${addrQ}`,
      `bbb.org/search?find_text=${addrQ}`,
      `buildzoom.com/contractors?address=${addrQ}`,
      `publicrecords.com/property/${addrQ}`,
      `newhomesource.com/builder-reviews`,
    ];
    if (addr && moduleKey === 'maintenance_history') return [
      `permitdata.org/?address=${addrQ}`,
      `publicrecords.com/property/${addrQ}`,
      `netronline.com/getrecordinformation.aspx?address=${addrQ}`,
      `clrsearch.com/Property_Records/${addrQ}`,
    ];
    if (moduleKey === 'neighborhood') return addr ? [
      `city-data.com/city/${addrQ}.html`,
      `areavibes.com/${addrQ}/livability`,
      `spotcrime.com/crimes/${addrQ}`,
      `crimemapping.com`,
      `commutesolutions.org`,
    ] : MODULE_SOURCES.neighborhood;
    if (moduleKey === 'insurance') return addr ? [
      `fema.gov/flood-maps/tools-resources/flood-map-service-center`,
      `floodsmart.gov/flood-map-zone`,
      `iii.org/article/homeowners-insurance-basics`,
      `naic.org/index_consumer.htm`,
      `disasterassistance.gov`,
    ] : MODULE_SOURCES.insurance;
    if (moduleKey === 'health') return MODULE_SOURCES.health;
    if (moduleKey === 'language') return MODULE_SOURCES.language;
    const t = (bulletText || '').toLowerCase();
    for (const { re, sources } of _BULLET_SOURCE_MAP) {
      if (re.test(t)) return sources;
    }
    return MODULE_SOURCES[moduleKey] || MODULE_SOURCES.verify;
  }

  function _cacheCurrentBullet() {
    if (activeDetailKey === null || detailChatMessages.length === 0) return;
    const key = `${activeDetailKey}||${activeDetailBullet}`;
    _bulletChatCache.set(key, {
      messages: [...detailChatMessages],
      html: document.getElementById('truvala-detail-chat-log').innerHTML,
    });
    updateBulletHistoryIcon(activeDetailKey, activeDetailBullet);
  }

  function scrollDetailChatToBottom() {
    const log = document.getElementById('truvala-detail-chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function renderWithLinks(raw) {
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = linkRe.exec(raw)) !== null) {
      out += escapeHTML(raw.slice(last, m.index));
      out += `<a href="${escapeHTML(m[2])}" target="_blank" rel="noopener noreferrer" class="truvala-source-anchor">${escapeHTML(m[1])}</a>`;
      last = m.index + m[0].length;
    }
    out += escapeHTML(raw.slice(last));
    return out;
  }

  function renderDetailResponse(text) {
    let html = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) { html += '<div class="truvala-detail-spacer"></div>'; continue; }
      if (t.startsWith('**') && t.endsWith('**')) {
        html += `<div class="truvala-detail-section-hdr">${escapeHTML(t.slice(2, -2))}</div>`;
      } else if (/^·\s/.test(t) || /^\s{2,}[•·\-]\s/.test(line)) {
        html += `<div class="truvala-detail-resp-subbullet"><span class="truvala-resp-subbullet-dot"></span><span>${renderWithLinks(t.replace(/^[·•\-]\s*/, ''))}</span></div>`;
      } else if (/^[•\-]\s/.test(t)) {
        html += `<div class="truvala-detail-resp-bullet"><span class="truvala-resp-bullet-dot"></span><span>${renderWithLinks(t.slice(2).trim())}</span></div>`;
      } else if (t.startsWith('→')) {
        const qText = t.slice(1).trim();
        const safeQ = qText.replace(/"/g, '&quot;');
        html += `<div class="truvala-detail-resp-question truvala-q-clickable" data-question="${safeQ}" title="Click to ask Truvala"><span class="truvala-resp-arrow">→</span><span>${renderWithLinks(qText)}</span></div>`;
      } else if (/^\d+\.\s/.test(t)) {
        html += `<div class="truvala-detail-resp-bullet"><span class="truvala-resp-bullet-dot"></span><span>${renderWithLinks(t.replace(/^\d+\.\s/, ''))}</span></div>`;
      } else {
        html += `<div class="truvala-detail-resp-text">${renderWithLinks(t)}</div>`;
      }
    }
    return html;
  }

  function appendDetailMessage(role, content) {
    const log = document.getElementById('truvala-detail-chat-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = `truvala-chat-msg truvala-msg-${role}`;
    div.innerHTML = role === 'user'
      ? `<div class="truvala-msg-bubble">${escapeHTML(content)}</div>`
      : `<div class="truvala-msg-avatar">T</div><div class="truvala-detail-response">${renderDetailResponse(content)}</div>`;
    log.appendChild(div);
    scrollDetailChatToBottom();
  }

  function showDetailTyping() {
    const log = document.getElementById('truvala-detail-chat-log');
    if (!log || document.getElementById('truvala-detail-typing')) return;
    const div = document.createElement('div');
    div.id = 'truvala-detail-typing';
    div.className = 'truvala-chat-msg truvala-msg-assistant';
    div.innerHTML = `
      <div class="truvala-msg-avatar">T</div>
      <div class="truvala-msg-bubble truvala-typing-bubble">
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
        <span class="truvala-typing-dot"></span>
      </div>`;
    log.appendChild(div);
    scrollDetailChatToBottom();
  }

  function removeDetailTyping() {
    document.getElementById('truvala-detail-typing')?.remove();
  }

  function markSourcesDone() {
    const hdr = document.querySelector('#truvala-detail-sources .truvala-sources-header');
    if (!hdr) return;
    hdr.innerHTML = '<span class="truvala-sources-done">✓</span>Sources checked';
  }

  async function showDetailResearchSources(sources) {
    const log = document.getElementById('truvala-detail-chat-log');
    if (!log) return;
    const container = document.createElement('div');
    container.id = 'truvala-detail-sources';
    container.className = 'truvala-sources-container';
    container.innerHTML = `
      <div class="truvala-sources-header">
        <span class="truvala-sources-spinner"></span>
        Researching sources…
      </div>
      <div class="truvala-sources-list" id="truvala-sources-list"></div>`;
    log.appendChild(container);
    scrollDetailChatToBottom();
    const list = document.getElementById('truvala-sources-list');
    for (const src of sources) {
      await new Promise(r => setTimeout(r, 430));
      if (!document.getElementById('truvala-detail-sources')) break;
      const item = document.createElement('div');
      item.className = 'truvala-source-item truvala-source-appear';
      item.innerHTML = `<span class="truvala-source-check">✓</span><span class="truvala-source-link">${escapeHTML(src)}</span>`;
      list.appendChild(item);
      scrollDetailChatToBottom();
    }
  }

  function showDetailSourcesDone(sources) {
    const log = document.getElementById('truvala-detail-chat-log');
    if (!log) return;
    const items = sources.map(src =>
      `<div class="truvala-source-item truvala-source-appear"><span class="truvala-source-check">✓</span><span class="truvala-source-link">${escapeHTML(src)}</span></div>`
    ).join('');
    const container = document.createElement('div');
    container.id = 'truvala-detail-sources';
    container.className = 'truvala-sources-container';
    container.innerHTML = `
      <div class="truvala-sources-header"><span class="truvala-sources-done">✓</span>Sources checked</div>
      <div class="truvala-sources-list">${items}</div>`;
    log.appendChild(container);
  }

  async function sendDetailChatMessage(content) {
    const text = content.trim();
    if (!text || !currentReport) return;
    const input   = document.getElementById('truvala-detail-chat-input');
    const sendBtn = document.getElementById('truvala-detail-chat-send');
    if (input)   input.disabled   = true;
    if (sendBtn) sendBtn.disabled = true;
    detailChatMessages.push({ role: 'user', content: text });
    appendDetailMessage('user', text);
    if (input) input.value = '';
    showDetailTyping();
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages:       detailChatMessages,
          risk_report:    currentReport.risk_report || {},
          listing:        currentReport.listing     || {},
          preferences:    currentPrefs,
          score:          currentReport.score       || 0,
          capex_estimate: currentReport.capex_estimate || '',
        }),
      });
      const data = await res.json();
      removeDetailTyping();
      detailChatMessages.push({ role: 'assistant', content: data.message });
      appendDetailMessage('assistant', data.message);
    } catch {
      removeDetailTyping();
      const errMsg = 'Sorry, something went wrong. Please try again.';
      detailChatMessages.push({ role: 'assistant', content: errMsg });
      appendDetailMessage('assistant', errMsg);
    } finally {
      if (input)   { input.disabled = false; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function updateBulletHistoryIcon(moduleKey, bulletText) {
    if (!moduleKey || bulletText == null) return;
    const drawer = document.getElementById('truvala-risk-drawer');
    if (!drawer) return;
    const bullets = drawer.querySelectorAll(`.truvala-compact-bullet[data-module-key="${moduleKey}"]`);
    for (const el of bullets) {
      if (el.dataset.bulletText === bulletText) {
        const icon = el.querySelector('.truvala-bullet-history-icon');
        if (icon) icon.style.display = 'inline-flex';
        break;
      }
    }
  }

  function closeRiskDetailPanel() {
    if (activeDetailKey !== null && detailChatMessages.length > 0) {
      const key = `${activeDetailKey}||${activeDetailBullet}`;
      _bulletChatCache.set(key, {
        messages: [...detailChatMessages],
        html: document.getElementById('truvala-detail-chat-log').innerHTML,
      });
      updateBulletHistoryIcon(activeDetailKey, activeDetailBullet);
    }
    document.getElementById('truvala-risk-detail-panel').classList.remove('truvala-visible');
    document.getElementById('truvala-panel').classList.remove('truvala-panel-collapsed');
    document.getElementById('truvala-risk-drawer').classList.remove('truvala-drawer-shifted');
    document.getElementById('truvala-risk-detail-panel').classList.remove('truvala-detail-shifted');
    activeDetailKey    = null;
    activeDetailBullet = null;
  }

  async function openRiskDetailPanel(moduleKey, bulletText) {
    if (!currentReport) return;
    const label = MODULE_LABELS[moduleKey] || moduleKey;

    const newCacheKey = `${moduleKey}||${bulletText}`;

    // Already showing the same bullet — just focus input
    if (activeDetailKey === moduleKey && activeDetailBullet === bulletText &&
        document.getElementById('truvala-risk-detail-panel').classList.contains('truvala-visible')) {
      document.getElementById('truvala-detail-chat-input')?.focus();
      return;
    }

    // Save current chat before switching bullets (only if a full response exists)
    if (activeDetailKey !== null && detailChatMessages.some(m => m.role === 'assistant')) {
      const oldKey = `${activeDetailKey}||${activeDetailBullet}`;
      _bulletChatCache.set(oldKey, {
        messages: [...detailChatMessages],
        html: document.getElementById('truvala-detail-chat-log').innerHTML,
      });
      updateBulletHistoryIcon(activeDetailKey, activeDetailBullet);
    }

    activeDetailKey    = moduleKey;
    activeDetailBullet = bulletText || null;
    document.getElementById('truvala-detail-title').textContent = label;
    document.getElementById('truvala-detail-chat-log').innerHTML = '';
    detailChatMessages = [];
    document.getElementById('truvala-risk-detail-panel').classList.add('truvala-visible');

    // Collapse main panel to sidetab
    document.getElementById('truvala-panel').classList.add('truvala-panel-collapsed');
    document.getElementById('truvala-risk-drawer').classList.add('truvala-drawer-shifted');
    document.getElementById('truvala-risk-detail-panel').classList.add('truvala-detail-shifted');

    // Restore from cache if we've visited this bullet before
    const cached = _bulletChatCache.get(newCacheKey);
    if (cached) {
      detailChatMessages = [...cached.messages];
      if (cached.html) {
        document.getElementById('truvala-detail-chat-log').innerHTML = cached.html;
      } else {
        // Background-cached: re-render sources (done state) then message
        if (cached.sources) showDetailSourcesDone(cached.sources);
        const assistantMsg = cached.messages.find(m => m.role === 'assistant');
        if (assistantMsg) appendDetailMessage('assistant', assistantMsg.content);
      }
      scrollDetailChatToBottom();
      return;
    }

    // Bullet-specific sources
    const listing = currentReport.listing || {};
    const addr    = listing.address || currentAddress || '';
    const addrQ   = encodeURIComponent(addr);
    const resolvedSources = getBulletSources(moduleKey, bulletText, addr, addrQ);

    // Animate source links, then fetch
    await showDetailResearchSources(resolvedSources);

    const sourcesForPrompt = resolvedSources.join('\n- ');
    const bulletContext = bulletText ? `, focused on: "${bulletText}"` : '';

    // Extract builder name for builder_info module
    const builderName = listing.builder || listing.developer || (() => {
      const facts = currentReport.risk_report?.builder_info?.observed_facts || [];
      const fact = facts.find(f => /^Builder (on record|reference detected)/.test(f));
      return fact ? fact.replace(/^Builder (?:on record|reference detected in listing):\s*/, '') : '';
    })();

    const listingFacts = [
      listing.year_built     ? `Year built: ${listing.year_built}` : '',
      listing.property_type  ? `Type: ${listing.property_type}`    : '',
      listing.address        ? `Address: ${listing.address}`       : '',
      builderName            ? `Builder/Developer: ${builderName}` : '',
      listing.description    ? `Listing excerpt: "${String(listing.description).slice(0, 350)}…"` : '',
    ].filter(Boolean).join('\n');

    const moduleSpecificInstruction = (() => {
      if (moduleKey === 'builder_info') {
        return builderName
          ? `\nThe builder for this property is ${builderName}. Research specifically: their BBB complaint rating, any known class-action or construction defect lawsuits, their warranty program and responsiveness, and quality review history. Name ${builderName} explicitly throughout your response.`
          : `\nNo builder name was found in this listing. Ask the buyer to request the builder's name, then check BBB complaint history, construction defect records, and warranty terms.`;
      }
      if (moduleKey === 'health') {
        return `\nFocus exclusively on documented health hazards for this home. Cover: lead paint (pre-1978), asbestos-containing materials, mold or moisture issues, radon, carbon monoxide risks, knob-and-tube or aluminum wiring fire hazards, Chinese drywall off-gassing, and polybutylene plumbing health risks. Always cite official health agency sources.`;
      }
      if (moduleKey === 'component_lifespan') {
        return `\nFor the specific component "${bulletText}", provide: (1) typical lifespan range and estimated age based on the build year, (2) estimated replacement cost range, (3) key warning signs to check during inspection, (4) maintenance tips to extend its life, (5) specific questions to ask the home inspector. Be concrete with numbers.`;
      }
      if (moduleKey === 'neighborhood') {
        const isTraffic = /traffic|commute/i.test(bulletText || '');
        const city = listing.city || addr || 'this area';
        return isTraffic
          ? `\nCover traffic and commute for ${city}: nearest highways and interstates, rush-hour drive times to 1–2 city centers, transit options. Be specific and concise — 2 Key Risk Signals max.`
          : `\nCrime stats for ${city} and its closest surrounding towns. Include safety ratings and violent vs. property crime breakdown for each town. Be concise — 2 Key Risk Signals max.`;
      }
      if (moduleKey === 'language') {
        return `\nAnalyze the high-risk language found in this listing. Explain what each red-flag phrase legally implies for the buyer, what obligations or liabilities it may shift to the buyer, and what specific due diligence steps to take before signing. Be concrete about the buyer's legal rights.`;
      }
      if (moduleKey === 'insurance') {
        const isLandLease = /land.lease|ground.lease|leasehold/i.test(bulletText || '');
        const isDisaster  = /natural.disaster|flood|wildfire|earthquake|hurricane|storm/i.test(bulletText || '');
        if (isLandLease) return `\nInvestigate land lease status for this property: what it means, how rent escalates over time, resale impact, and key lease terms to review. Be concise — 2 Key Risk Signals max.`;
        if (isDisaster)  return `\nDisaster exposure for ${addr || 'this area'}: FEMA flood zone, wildfire/seismic risk, notable historical events, estimated annual disaster coverage cost. Be concise — 2 Key Risk Signals max.`;
        return `\nInsurance in ${listing.state || 'its state'}: whether major carriers are writing policies here, estimated annual premium range, lender-required coverage types. Be concise — 2 Key Risk Signals max.`;
      }
      return '';
    })();

    const researchPrompt = `You are analyzing the "${label}" risk factor${bulletContext} for a specific property. Use the listing details below to ground your response — do not give generic advice.

Property details:
${listingFacts || '(see listing data provided)'}
${moduleSpecificInstruction}
Reply using ONLY these three sections with exact markdown headers. Break every point into sub-bullets using · (middle dot). No paragraph blocks.

**Key Risk Signals**
• [Signal name]
  · [What the risk is — 1 sentence]
  · [Health hazard level or cost range: $X–$Y]
  · [source-name](https://full-url)

**Why This Property**
• [Reason specific to this home]
  · [What in the listing details above suggests this — be concrete]
  · [Likely cost impact or health consequence]
  · [source-name](https://full-url)

**Questions for Your Realtor**
→ [one specific, actionable question]
→ [another question]
→ [another question]

Cite from these sources (use the actual URLs):
- ${sourcesForPrompt}`;

    // Capture identity for this specific generation — survives tab switches
    const thisModuleKey   = moduleKey;
    const thisBulletText  = bulletText || null;
    const thisCacheKey    = `${thisModuleKey}||${thisBulletText}`;
    const thisMessages    = [{ role: 'user', content: researchPrompt }];
    detailChatMessages = thisMessages;
    showDetailTyping();
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages:       thisMessages,
          risk_report:    currentReport.risk_report || {},
          listing:        currentReport.listing     || {},
          preferences:    currentPrefs,
          score:          currentReport.score       || 0,
          capex_estimate: currentReport.capex_estimate || '',
        }),
      });
      const data = await res.json();
      thisMessages.push({ role: 'assistant', content: data.message });
      const isStillActive = activeDetailKey === thisModuleKey && activeDetailBullet === thisBulletText;
      if (isStillActive) {
        detailChatMessages = thisMessages;
        removeDetailTyping();
        appendDetailMessage('assistant', data.message);
        markSourcesDone();
        _cacheCurrentBullet();
      } else {
        // Switched away mid-generation — cache silently without touching DOM
        _bulletChatCache.set(thisCacheKey, { messages: thisMessages, html: null, sources: resolvedSources });
        updateBulletHistoryIcon(thisModuleKey, thisBulletText);
      }
    } catch {
      if (activeDetailKey === thisModuleKey && activeDetailBullet === thisBulletText) {
        removeDetailTyping();
        appendDetailMessage('assistant', `I've reviewed the ${label} for this property. Feel free to ask me anything about it.`);
        markSourcesDone();
        _cacheCurrentBullet();
      }
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
        <div class="truvala-sidetab-label">Truvala</div>
        <div class="truvala-panel-header">
          <div class="truvala-panel-branding">
            <div class="truvala-panel-logo">Truvala</div>
            <div class="truvala-panel-address" id="truvala-address"></div>
          </div>
          <button id="truvala-costs-toggle" style="font-size:11px;font-weight:600;padding:4px 10px;border-radius:8px;border:1.5px solid #e2e8f0;background:#f8fafc;color:#1e3a8a;cursor:pointer">Costs</button>
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

      <div id="truvala-risk-drawer" class="truvala-risk-drawer" role="complementary" aria-label="Full report">
        <div class="truvala-drawer-header">
          <div class="truvala-drawer-title">
            <span style="font-size:15px">⚠</span>
            Full Report
          </div>
          <button class="truvala-panel-close" id="truvala-risk-drawer-close" aria-label="Close report">
            ${ICON_CLOSE}
          </button>
        </div>
        <div class="truvala-drawer-modules" id="truvala-drawer-modules"></div>
      </div>

      <div id="truvala-risk-detail-panel" class="truvala-risk-detail-panel" role="complementary" aria-label="Risk factor detail">
        <div class="truvala-drawer-header">
          <div class="truvala-drawer-title" id="truvala-detail-title">Factor Analysis</div>
          <button class="truvala-panel-close" id="truvala-detail-close" aria-label="Close">${ICON_CLOSE}</button>
        </div>
        <div class="truvala-detail-body">
          <div class="truvala-detail-chat-label">
            <span class="truvala-detail-label-text">Ask Truvala</span>
            <span class="truvala-ai-tag">AI</span>
          </div>
          <div class="truvala-detail-chat-log" id="truvala-detail-chat-log"></div>
        </div>
        <div class="truvala-chat-input-area">
          <input class="truvala-chat-input" id="truvala-detail-chat-input"
            type="text" placeholder="Ask about this risk factor…" autocomplete="off" spellcheck="false">
          <button class="truvala-chat-send" id="truvala-detail-chat-send" aria-label="Send">↑</button>
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

    // Mini bubble reopens the panel
    document.getElementById('truvala-mini').addEventListener('click', () => {
      setState('panel');
    });

    // Bubble close: if editing go back to minimized, else go idle
    document.getElementById('truvala-bubble-close').addEventListener('click', () => {
      setState(currentReport ? 'minimized' : 'idle');
    });

    // Backdrop click: minimize and close risk drawer + detail panel
    document.getElementById('truvala-backdrop').addEventListener('click', () => {
      closeRiskDetailPanel();
      closeRiskDrawer();
      setState('minimized');
    });

    // Panel close: minimize and close risk drawer + detail panel
    document.getElementById('truvala-panel-close').addEventListener('click', () => {
      closeRiskDetailPanel();
      closeRiskDrawer();
      setState('minimized');
    });

    // Risk drawer close (also closes detail panel)
    document.getElementById('truvala-risk-drawer-close').addEventListener('click', () => {
      closeRiskDetailPanel();
      closeRiskDrawer();
    });

    // Risk drawer — module header toggles accordion only; bullet click opens detail panel
    document.getElementById('truvala-risk-drawer').addEventListener('click', (e) => {
      const bullet = e.target.closest('.truvala-compact-bullet[data-module-key]');
      if (bullet) {
        const moduleKey  = bullet.dataset.moduleKey;
        const bulletText = bullet.dataset.bulletText || '';
        if (moduleKey) openRiskDetailPanel(moduleKey, bulletText);
        return;
      }
      const riskBtn = e.target.closest('.truvala-risk-module-btn');
      if (riskBtn) {
        const mod     = riskBtn.closest('.truvala-risk-module');
        const body    = mod.querySelector('.truvala-risk-module-body');
        const chevron = riskBtn.querySelector('.truvala-risk-chevron');
        const open    = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)';
        return;
      }
    });

    // Detail panel close button
    document.getElementById('truvala-detail-close').addEventListener('click', closeRiskDetailPanel);

    // Clickable questions (→ lines) auto-send as chat messages
    document.getElementById('truvala-risk-detail-panel').addEventListener('click', (e) => {
      const q = e.target.closest('.truvala-q-clickable');
      if (q) sendDetailChatMessage(q.dataset.question);
    });

    // Detail panel chat send button + Enter key
    document.getElementById('truvala-detail-chat-send').addEventListener('click', () => {
      const input = document.getElementById('truvala-detail-chat-input');
      sendDetailChatMessage(input.value);
    });
    document.getElementById('truvala-detail-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDetailChatMessage(e.target.value);
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
    document.getElementById('truvala-costs-toggle').addEventListener('click', toggleCosts);

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

    // Sidetab — clicking the collapsed panel restores it
    document.getElementById('truvala-panel').addEventListener('click', (e) => {
      if (document.getElementById('truvala-panel').classList.contains('truvala-panel-collapsed')) {
        closeRiskDetailPanel();
      }
    });

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
        if (open) closeFieldPopover();
        return;
      }

      // Field chip → popover
      const chip = e.target.closest('.truvala-breakdown-chip');
      if (chip) { showFieldPopover(chip); return; }

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
