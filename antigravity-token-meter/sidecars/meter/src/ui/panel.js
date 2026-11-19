(function () {
  const qs = new URLSearchParams(location.search);
  const uiToken = qs.get('token') || '';
  const initialCid = qs.get('conversationId') || '';

  // 握手读取后立即剥离地址栏中的敏感 token 参数，防止滞留于历史记录或 Referer
  if (uiToken && window.history && typeof window.history.replaceState === 'function') {
    qs.delete('token');
    const clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash;
    try { window.history.replaceState(null, '', clean); } catch {}
  }

  const DICT = window.__AG_TM_I18N__ || { 'zh-CN': { diag: {} }, en: { diag: {} } };
  let lang = 'zh-CN';
  let prefs = { language: 'zh-CN', showSpeed: true, showCache: true, showContext: true, showQuota: true, showToday: false, version: 0 };
  let confirmedVersion = 0;
  let reqSeq = 0;

  function t(k) { return (DICT[lang] && DICT[lang][k]) || (DICT['zh-CN'] && DICT['zh-CN'][k]) || k; }
  function tDiag(code) {
    const d = (DICT[lang] && DICT[lang].diag) || (DICT['zh-CN'] && DICT['zh-CN'].diag) || {};
    return d[code] || d.cdp_unreachable || String(code || '');
  }
  function safeInt(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
  function fmtTokens(n) {
    const v = safeInt(n);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }
  function fmtPct(f) { return typeof f === 'number' && Number.isFinite(f) ? Math.round(Math.max(0, Math.min(1, f)) * 100) + '%' : '--'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderSpark(points) {
    if (!Array.isArray(points) || points.length < 2) return '<div style="color:var(--muted);font-size:12px;">' + esc(t('noData')) + '</div>';
    const w = 320, h = 54, pad = 5;
    const vals = points.map((p) => { const v = Number(p && p.tps); return Number.isFinite(v) && v >= 0 ? v : 0; });
    const min = Math.min(...vals), max = Math.max(...vals), span = Math.max(1, max - min);
    const coords = vals.map((v, i) => `${(pad + (i / (vals.length - 1)) * (w - pad * 2)).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`);
    const area = `${pad},${h - pad} ${coords.join(' ')} ${w - pad},${h - pad}`;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><polygon points="${area}" fill="var(--accent-soft)"/><polyline points="${coords.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  async function apiGet(path) {
    const headers = {};
    if (uiToken) headers['x-sidecar-token'] = uiToken;
    const r = await fetch(path, { cache: 'no-store', headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function apiPost(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (uiToken) headers['x-sidecar-token'] = uiToken;
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function renderToggles() {
    const items = [
      ['showSpeed', t('optSpeed')], ['showCache', t('optCache')],
      ['showContext', t('optContext')], ['showQuota', t('optQuota')], ['showToday', t('optToday')],
    ];
    const box = document.getElementById('toggles');
    box.innerHTML = items.map(([k, label]) => `<label><input type="checkbox" data-k="${esc(k)}" ${prefs[k] ? 'checked' : ''}/>${esc(label)}</label>`).join('');
    box.querySelectorAll('input').forEach((inp) => {
      inp.onchange = async () => {
        try {
          const next = await apiPost('./api/preferences', { [inp.dataset.k]: inp.checked });
          if (next && !next.error) {
            prefs = next;
            confirmedVersion = Math.max(confirmedVersion, safeInt(next.version));
            renderToggles();
          }
        } catch {
          inp.checked = !inp.checked;
        }
      };
    });
  }

  function applyStaticLabels() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-k]').forEach((el) => { el.textContent = t(el.dataset.k); });
    document.getElementById('lang-btn').textContent = lang === 'en' ? '中文' : 'EN';
    document.getElementById('refresh-btn').textContent = t('refresh');
  }

  async function refresh() {
    if (document.hidden) return;
    const mySeq = ++reqSeq;
    try {
      const q = initialCid ? `?conversationId=${encodeURIComponent(initialCid)}` : '';
      const data = await apiGet('./api/snapshot' + q);
      if (mySeq !== reqSeq) return;

      if (data.version) document.getElementById('ver').textContent = 'v' + String(data.version);
      if (data.preferences && safeInt(data.preferences.version) >= confirmedVersion) {
        prefs = data.preferences;
        confirmedVersion = safeInt(prefs.version);
        lang = prefs.language === 'en' ? 'en' : 'zh-CN';
      }
      applyStaticLabels();

      const diag = data.integration || {};
      const banner = document.getElementById('diag-banner');
      const ok = diag.state === 'mounted' || diag.state === 'waiting_composer';
      banner.className = 'banner ' + (ok ? 'ok' : 'warn');
      banner.textContent = (ok ? '● ' : '⚠ ') + tDiag(diag.code || diag.state);

      const c = data.conversation || {};
      document.getElementById('k-latest').textContent = c.latestTps != null ? `${Number(c.latestTps).toFixed(1)} ${t('speedUnit')}` : '--';
      document.getElementById('k-session').textContent = c.tps != null ? `${Number(c.tps).toFixed(1)} ${t('speedUnit')}` : '--';
      document.getElementById('k-cache').textContent = fmtPct(c.cacheHitRate);
      document.getElementById('k-ctx').textContent = c.context ? fmtPct(c.context.usedFraction) : '--';
      document.getElementById('model-name').textContent = c.model || (data.conversationUnavailable ? t('convUnavailable') : '');
      document.getElementById('sparkline').innerHTML = renderSpark(c.sparkline);

      const quotas = data.quotas || [];
      document.getElementById('quotas').innerHTML = quotas.length
        ? quotas.map((item) => {
            const pct = Math.round(Math.max(0, Math.min(1, Number(item.remainingFraction) || 0)) * 100);
            return `<div class="q-item"><div class="q-meta"><span>${esc(item.title)}</span><span>${pct}%</span></div><div class="q-bar"><div class="q-fill" style="width:${pct}%"></div></div></div>`;
          }).join('')
        : `<div style="color:var(--muted);font-size:12px;">${esc(t('noData'))}</div>`;

      const usage = data.usage || {};
      document.getElementById('today-sum').textContent = `${t('today')}: ${fmtTokens(usage.todayTokens)}`;
      const ranks = usage.modelRank || [];
      const tbody = document.getElementById('rank-body');
      tbody.textContent = '';
      if (!ranks.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.style.color = 'var(--muted)';
        td.style.textAlign = 'center';
        td.textContent = t('noData');
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const m of ranks) {
          const tr = document.createElement('tr');
          for (const cellText of [
            String(m.model || ''),
            fmtTokens(m.totalTokens),
            m.avgTps != null ? Number(m.avgTps).toFixed(1) : '--',
            String(safeInt(m.requests)),
          ]) {
            const td = document.createElement('td');
            td.textContent = cellText;
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }

      renderToggles();
    } catch {
      if (mySeq !== reqSeq) return;
      const banner = document.getElementById('diag-banner');
      banner.className = 'banner warn';
      banner.textContent = '⚠ ' + t('fetchError');
    }
  }

  document.getElementById('refresh-btn').onclick = () => void refresh();
  document.getElementById('lang-btn').onclick = async () => {
    try {
      const next = await apiPost('./api/preferences', { language: lang === 'en' ? 'zh-CN' : 'en' });
      if (next && !next.error) {
        prefs = next;
        confirmedVersion = Math.max(confirmedVersion, safeInt(next.version));
        lang = prefs.language;
        void refresh();
      }
    } catch {}
  };

  applyStaticLabels();
  void refresh();
  setInterval(() => void refresh(), 3000);
})();
