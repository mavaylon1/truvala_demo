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
    console.log('[Truvala] report received:', JSON.stringify(report, null, 2));
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
    const costsSnippet = buildCostsHTML(report.monthly_costs, report.ecosolar);
    console.log('[Truvala] costsHTML length:', costsSnippet.length, '| first 200:', costsSnippet.slice(0, 200));
    const fullHTML = buildReportHTML(report);
    console.log('[Truvala] fullHTML starts with:', fullHTML.slice(0, 300));
    const panelBody = document.getElementById('truvala-panel-body');
    panelBody.innerHTML = fullHTML;
    panelBody.scrollTop = 0;
    console.log('[Truvala] first child tag:', panelBody.firstElementChild?.tagName, '| style:', panelBody.firstElementChild?.getAttribute('style')?.slice(0, 60));

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
    const colors = ['#10b981', '#f59e0b', '#ef4444'];
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

  function buildReportHTML(report) {
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

    const PREVIEW = 160;
    const summaryFull = report.summary;
    const summaryShort = summaryFull.length > PREVIEW ? summaryFull.slice(0, PREVIEW).trim() + '…' : null;
    const summaryHTML = summaryShort ? `
      <p class="truvala-summary-text"><span id="truvala-summary-preview">${summaryShort}</span><span id="truvala-summary-full" style="display:none">${summaryFull}</span></p>
      <button class="truvala-expand-btn" id="truvala-summary-toggle">Read full summary ›</button>
    ` : `<p class="truvala-summary-text">${summaryFull}</p>`;

    return `
      <div class="truvala-score-section">
        <div class="truvala-score-ring-wrap">${buildScoreRing(report.score)}</div>
        <div class="truvala-score-meta">
          <div class="truvala-score-label">Buyer Fit Score</div>
          <div class="truvala-score-value" style="color:${scoreColor(report.score)}">${report.score}</div>
          <span class="truvala-risk-badge ${riskClass(report.risk)}">${report.risk} risk</span>
          ${buildRiskGauge(report.risk)}
          <div class="truvala-capex-row" style="margin-top:4px">Est. capex: <strong>${report.capex_estimate}</strong></div>
        </div>
      </div>

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#eff6ff;color:#1e3a8a">✦</span>
          Summary
        </div>
        ${summaryHTML}
      </div>

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#fef3c7;color:#b45309">!</span>
          Warnings
        </div>
        ${collapsibleList(report.warnings, 'warning', '!', 3)}
      </div>

      ${report.monthly_costs ? `
      <button id="truvala-costs-btn" style="width:100%;padding:13px 18px;border-radius:12px;border:none;background:#1e3a8a;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,sans-serif;box-shadow:0 4px 14px rgba(30,58,138,0.3);letter-spacing:-0.01em">
        <span>Monthly Costs &amp; Savings</span>
        <span style="font-size:18px;opacity:0.7">›</span>
      </button>` : ''}

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#d1fae5;color:#047857">✓</span>
          What works for you
        </div>
        ${collapsibleList(report.positives, 'positive', '✓', 2)}
      </div>

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#eff6ff;color:#2563eb">?</span>
          Ask before you tour
        </div>
        ${collapsibleList(report.questions, 'question', '?', 2)}
      </div>

      <div class="truvala-card">
        <div class="truvala-card-title">
          <span class="truvala-card-icon" style="background:#f1f5f9;color:#475569">≡</span>
          Preference Breakdown
        </div>
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

    // Costs toggle — header button and in-report button both trigger this
    const toggleCosts = () => {
      const existing = document.getElementById('truvala-costs-section');
      if (existing) { existing.remove(); return; }
      if (!currentReport?.monthly_costs) return;
      const section = document.createElement('div');
      section.id = 'truvala-costs-section';
      section.innerHTML = buildCostsHTML(currentReport.monthly_costs, currentReport.ecosolar);
      document.getElementById('truvala-panel-body').prepend(section);
    };
    document.getElementById('truvala-costs-toggle').addEventListener('click', toggleCosts);

    // In-report button and financing toggle use delegation
    document.getElementById('truvala-panel-body').addEventListener('click', (e) => {
      if (e.target.closest('#truvala-costs-btn')) { toggleCosts(); return; }

      // Summary expand
      if (e.target.id === 'truvala-summary-toggle') {
        const preview = document.getElementById('truvala-summary-preview');
        const full    = document.getElementById('truvala-summary-full');
        const btn     = document.getElementById('truvala-summary-toggle');
        if (preview && full) {
          const open = full.style.display !== 'none';
          preview.style.display = open ? '' : 'none';
          full.style.display    = open ? 'none' : '';
          btn.textContent = open ? 'Read full summary ›' : 'Show less';
        }
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
