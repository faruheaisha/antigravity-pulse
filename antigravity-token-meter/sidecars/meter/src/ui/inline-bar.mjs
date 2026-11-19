/**
 * 隔离世界运行的 Shadow DOM 底部状态条脚本生成器。
 *
 * 加固要点：
 * 1. 仅与隔离世界私有桥 window.__agTokenMeterApi 通信，不向宿主主世界暴露对象；
 * 2. 请求携带单调 requestSeq 代次号，切换会话时丢弃过期慢响应，杜绝串会话；
 * 3. 所有动态字段均严格转义或安全整数化，零未转义 HTML sink；
 * 4. 热力图按近 112 天可见窗口峰值定色；弹窗支持 Escape 关闭、visualViewport 双向夹取；
 * 5. 透明 body 不误判深色主题；挂载完成后才置位 window.__agTokenMeterMounted。
 */
import { I18N_DICT } from '../i18n.mjs';

export function buildInlineWidgetScript() {
  const dictJson = JSON.stringify(I18N_DICT);
  return `(function(I18N){
    if (window !== window.top) return;
    if (window.__agTokenMeterMounted) return;

    var HOST_ID = 'ag-token-meter-host';
    var MODAL_ID = 'ag-token-meter-modal-host';
    var EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    var state = {
      disposed: false,
      snapshot: null,
      prefs: { language: 'zh-CN', showSpeed: true, showCache: true, showContext: true, showQuota: true, showToday: false, version: 0 },
      confirmedPrefVersion: 0,
      popoverOpen: false,
      pinned: false,
      modalOpen: false,
      dark: false,
      lastCid: null,
      requestSeq: 0,
      hoverTimer: null,
    };

    var hostEl = null;
    var shadow = null;
    var modalHost = null;
    var modalShadow = null;
    var observer = null;
    var pollTimer = null;
    var mountDebounce = null;

    function t(key) {
      var lang = state.prefs && state.prefs.language === 'en' ? 'en' : 'zh-CN';
      return (I18N[lang] && I18N[lang][key]) || I18N['zh-CN'][key] || key;
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    }

    function safeInt(v) {
      var n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    function fmtTokens(n) {
      var v = safeInt(n);
      if (v <= 0) return '0';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return String(v);
    }

    function fmtPct(frac) {
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--';
      return Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    }

    function fmtCountdown(iso) {
      if (!iso) return '--';
      var ms = Date.parse(iso) - Date.now();
      if (!Number.isFinite(ms)) return '--';
      if (ms <= 0) return '0m';
      var mins = Math.floor(ms / 60000);
      var hrs = Math.floor(mins / 60);
      var days = Math.floor(hrs / 24);
      if (days > 0) return days + 'd ' + (hrs % 24) + 'h';
      if (hrs > 0) return hrs + 'h ' + (mins % 60) + 'm';
      return mins + 'm';
    }

    function detectDarkTheme() {
      try {
        if (document.documentElement.classList.contains('dark') || document.body?.classList?.contains('dark')) return true;
        var el = document.body || document.documentElement;
        var bg = el ? getComputedStyle(el).backgroundColor : '';
        var m = bg && bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/);
        if (m) {
          var alpha = m[4] === undefined ? 1 : Number(m[4]);
          // 忽略全透明背景，避免 rgba(0,0,0,0) 被误判为深色主题
          if (alpha > 0.2) {
            var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
            return lum < 0.45;
          }
        }
        return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch {
        return false;
      }
    }

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.closest && el.closest('[inert],[aria-hidden="true"]')) return false;
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 12 && r.height > 12;
    }

    function detectConversationId() {
      try {
        var m = location.pathname.match(/\\/c\\/([^/?#]+)/i);
        if (m && EXACT_UUID_RE.test(m[1])) return m[1];
        if (hostEl && hostEl.isConnected) {
          var owner = hostEl.closest('[data-cascade-id]');
          var cid = owner && owner.getAttribute('data-cascade-id');
          if (cid && EXACT_UUID_RE.test(cid)) return cid;
        }
      } catch {}
      return null;
    }

    function findComposerContainer() {
      var boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]')).filter(isVisible);
      if (boxes.length > 0) return boxes[boxes.length - 1];

      var editors = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="combobox"][contenteditable="true"], [aria-label="Message input"]')).filter(isVisible);
      for (var i = editors.length - 1; i >= 0; i--) {
        var cur = editors[i].parentElement;
        for (var depth = 0; depth < 6 && cur && cur !== document.body; depth++) {
          if (cur.querySelector('[data-testid="model-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]')) {
            return cur;
          }
          cur = cur.parentElement;
        }
      }
      return null;
    }

    function buildSparklineSvg(points) {
      if (!Array.isArray(points) || points.length < 2) {
        return '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>';
      }
      var w = 248, h = 44, pad = 4;
      var vals = points.map(function(p) { var v = Number(p && p.tps); return Number.isFinite(v) && v >= 0 ? v : 0; });
      var min = Math.min.apply(null, vals);
      var max = Math.max.apply(null, vals);
      var span = Math.max(1, max - min);
      var coords = vals.map(function(v, idx) {
        var x = pad + (idx / (vals.length - 1)) * (w - pad * 2);
        var y = h - pad - ((v - min) / span) * (h - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      var area = pad + ',' + (h - pad) + ' ' + coords.join(' ') + ' ' + (w - pad) + ',' + (h - pad);
      var last = coords[coords.length - 1].split(',');
      return '<svg class="tm-spark" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
        '<polygon points="' + area + '" fill="var(--tm-accent-soft)"/>' +
        '<polyline points="' + coords.join(' ') + '" fill="none" stroke="var(--tm-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="var(--tm-accent)"/>' +
      '</svg>';
    }

    function baseStyles() {
      return \`
        :host {
          --tm-card: #ffffff;
          --tm-border: rgba(15,23,42,0.12);
          --tm-text: #0f172a;
          --tm-muted: #64748b;
          --tm-chip: rgba(15,23,42,0.045);
          --tm-chip-hover: rgba(15,23,42,0.065);
          --tm-sep: rgba(15,23,42,0.22);
          --tm-accent: #0284c7;
          --tm-accent-soft: rgba(2,132,199,0.14);
          --tm-ok: #10b981;
          --tm-warn: #f59e0b;
          --tm-danger: #ef4444;
          --tm-shadow: 0 12px 32px rgba(15,23,42,0.14);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 11.5px;
          color: var(--tm-text);
          display: block;
        }
        :host([data-theme="dark"]) {
          --tm-card: #161b22;
          --tm-border: rgba(248,250,252,0.12);
          --tm-text: #e2e8f0;
          --tm-muted: #94a3b8;
          --tm-chip: rgba(248,250,252,0.07);
          --tm-chip-hover: rgba(248,250,252,0.08);
          --tm-sep: rgba(248,250,252,0.22);
          --tm-accent: #38bdf8;
          --tm-accent-soft: rgba(56,189,248,0.16);
          --tm-shadow: 0 14px 36px rgba(0,0,0,0.5);
        }
        .tm-bar-wrap { position: relative; display: flex; align-items: center; padding: 3px 8px 2px; user-select: none; }
        .tm-chips { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px; }
        .tm-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 5px; border-radius: 5px; background: transparent; border: none; color: var(--tm-muted); cursor: pointer; transition: background .15s, color .15s; line-height: 17px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
        .tm-chip:hover, .tm-chip:focus-visible { background: var(--tm-chip-hover); color: var(--tm-text); outline: none; }
        .tm-sep { color: var(--tm-sep); font-size: 11px; padding: 0 1px; pointer-events: none; }
        .tm-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--tm-ok); opacity: 0.85; display: inline-block; flex-shrink: 0; }
        .tm-dot.live { background: var(--tm-accent); opacity: 1; }
        .tm-dot.off { background: var(--tm-muted); opacity: 0.45; }
        .tm-label { color: var(--tm-muted); font-size: 11px; font-weight: 400; }
        .tm-val { color: var(--tm-text); font-weight: 500; opacity: 0.88; }
        .tm-chip:hover .tm-val { opacity: 1; }
        .tm-popover { position: fixed; z-index: 2147483600; width: min(312px, calc(100vw - 20px)); max-height: calc(100vh - 24px); overflow: auto; background: var(--tm-card); border: 1px solid var(--tm-border); border-radius: 12px; box-shadow: var(--tm-shadow); padding: 12px; box-sizing: border-box; display: none; }
        .tm-popover.open { display: block; }
        .tm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
        .tm-title { font-weight: 700; font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
        .tm-model { font-size: 11px; color: var(--tm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
        .tm-btn { border: 1px solid var(--tm-border); background: var(--tm-chip); color: var(--tm-text); border-radius: 6px; padding: 2px 7px; font-size: 11px; cursor: pointer; }
        .tm-btn:hover, .tm-btn:focus-visible { border-color: var(--tm-accent); color: var(--tm-accent); outline: none; }
        .tm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
        .tm-kpi { background: var(--tm-chip); border-radius: 8px; padding: 6px 8px; }
        .tm-kpi-k { font-size: 10.5px; color: var(--tm-muted); }
        .tm-kpi-v { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 1px; }
        .tm-sec { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--tm-border); }
        .tm-sec-title { font-size: 11px; color: var(--tm-muted); margin-bottom: 5px; display: flex; justify-content: space-between; }
        .tm-rows { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 11px; }
        .tm-row { display: flex; justify-content: space-between; gap: 4px; }
        .tm-row span:first-child { color: var(--tm-muted); }
        .tm-row span:last-child { font-weight: 600; font-variant-numeric: tabular-nums; }
        .tm-qitem { margin-bottom: 6px; }
        .tm-qmeta { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; gap: 6px; }
        .tm-qname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-qbar { height: 5px; border-radius: 99px; background: var(--tm-chip); overflow: hidden; }
        .tm-qfill { height: 100%; border-radius: 99px; background: var(--tm-accent); }
        .tm-qfill.warn { background: var(--tm-warn); }
        .tm-qfill.danger { background: var(--tm-danger); }
        .tm-foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--tm-border); display: flex; justify-content: space-between; align-items: center; }
        .tm-link { border: none; background: transparent; color: var(--tm-accent); font-weight: 600; font-size: 11.5px; cursor: pointer; padding: 2px 0; }
        .tm-link:hover { text-decoration: underline; }
        .tm-empty { color: var(--tm-muted); font-size: 11px; text-align: center; padding: 8px 0; }
        .tm-spark { display: block; }
      \`;
    }

    function modalStyles() {
      return baseStyles() + \`
        .tm-backdrop { position: fixed; inset: 0; z-index: 2147483640; background: rgba(2,6,23,0.52); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 18px; }
        .tm-modal { width: min(760px, 95vw); max-height: 88vh; overflow: auto; background: var(--tm-card); border: 1px solid var(--tm-border); border-radius: 16px; box-shadow: var(--tm-shadow); padding: 18px 20px; box-sizing: border-box; }
        .tm-mhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .tm-mtitle { font-size: 15px; font-weight: 700; }
        .tm-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
        .tm-heat { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; }
        .tm-heat-col { display: grid; grid-template-rows: repeat(7, 11px); gap: 3px; }
        .tm-cell { border-radius: 2px; background: var(--tm-chip); }
        .tm-cell.l1 { background: rgba(2,132,199,0.28); }
        .tm-cell.l2 { background: rgba(2,132,199,0.52); }
        .tm-cell.l3 { background: rgba(2,132,199,0.78); }
        .tm-cell.l4 { background: #0284c7; }
        .tm-table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 6px; }
        .tm-table th, .tm-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--tm-border); font-variant-numeric: tabular-nums; }
        .tm-table th { color: var(--tm-muted); font-weight: 600; font-size: 11px; }
        .tm-toggles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
        .tm-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer; }
      \`;
    }

    function positionPopover() {
      if (!shadow || !hostEl) return;
      var pop = shadow.getElementById('tm-popover');
      if (!pop || !state.popoverOpen) return;
      var vv = window.visualViewport;
      var vw = vv ? vv.width : window.innerWidth;
      var vh = vv ? vv.height : window.innerHeight;
      var rect = hostEl.getBoundingClientRect();
      var pw = pop.offsetWidth || 312;
      var ph = pop.offsetHeight || 340;
      var left = Math.max(10, Math.min(vw - pw - 10, rect.left + 8));
      var top = rect.top - ph - 6;
      if (top < 10) top = Math.max(10, Math.min(vh - ph - 10, rect.bottom + 6));
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function renderBar() {
      if (!shadow || !hostEl) return;
      state.dark = detectDarkTheme();
      hostEl.setAttribute('data-theme', state.dark ? 'dark' : 'light');

      var snap = state.snapshot;
      var conv = snap && snap.conversation;
      var usage = snap && snap.usage;
      var quotas = (snap && snap.quotas) || [];
      var prefs = state.prefs;

      var tpsVal = conv && (conv.latestTps != null ? conv.latestTps : conv.tps);
      var cacheVal = conv && conv.cacheHitRate;
      var ctxFrac = conv && conv.context && conv.context.usedFraction;
      var leadQuota = quotas[0] || null;
      var isRunning = Boolean(conv && conv.running);
      var dotCls = !snap || !snap.connected ? 'off' : isRunning ? 'live' : '';
      var expanded = state.popoverOpen ? 'true' : 'false';

      var chipItems = [];
      if (prefs.showSpeed !== false) {
        chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-dot ' + dotCls + '"></span><span class="tm-val">' +
          (tpsVal != null ? Number(tpsVal).toFixed(1) : '--') + '</span><span class="tm-label">' + escapeHtml(t('speedUnit')) + '</span></button>');
      }
      if (prefs.showCache !== false) {
        chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-label">' + escapeHtml(t('cacheHit')) + '</span><span class="tm-val">' + escapeHtml(fmtPct(cacheVal)) + '</span></button>');
      }
      if (prefs.showContext !== false) {
        chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-label">' + escapeHtml(t('context')) + '</span><span class="tm-val">' + escapeHtml(fmtPct(ctxFrac)) + '</span></button>');
      }
      if (prefs.showQuota !== false && leadQuota) {
        chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-label">' + escapeHtml(t('quota')) + '</span><span class="tm-val">' + escapeHtml(fmtPct(leadQuota.remainingFraction)) + '</span></button>');
      }
      if (prefs.showToday === true && usage) {
        chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-label">' + escapeHtml(t('today')) + '</span><span class="tm-val">' + escapeHtml(fmtTokens(usage.todayTokens)) + '</span></button>');
      }
      var chipsHtml = chipItems.length
        ? chipItems.join('<span class="tm-sep" aria-hidden="true">·</span>')
        : '<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1"><span class="tm-dot ' + dotCls + '"></span><span class="tm-val">' + escapeHtml(t('brand')) + '</span></button>';

      var chipsEl = shadow.getElementById('tm-chips');
      if (chipsEl) chipsEl.innerHTML = chipsHtml;

      var pop = shadow.getElementById('tm-popover');
      if (pop) {
        pop.classList.toggle('open', state.popoverOpen);
        if (state.popoverOpen) {
          var qHtml = quotas.slice(0, 4).map(function(q) {
            var pct = Math.round(Math.max(0, Math.min(1, Number(q.remainingFraction) || 0)) * 100);
            var cls = pct <= 15 ? 'danger' : pct <= 35 ? 'warn' : '';
            return '<div class="tm-qitem"><div class="tm-qmeta"><span class="tm-qname" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) +
              '</span><span>' + pct + '% · ' + escapeHtml(t('resetAt')) + ' ' + escapeHtml(fmtCountdown(q.resetTime)) + '</span></div>' +
              '<div class="tm-qbar"><div class="tm-qfill ' + cls + '" style="width:' + pct + '%"></div></div></div>';
          }).join('');

          var subtitle = (conv && conv.model) || (snap && snap.conversationUnavailable ? t('convUnavailable') : snap && snap.connected ? t('connected') : t('offline'));
          pop.innerHTML =
            '<div class="tm-head">' +
              '<div><div class="tm-title"><span class="tm-dot ' + dotCls + '"></span>' + escapeHtml(t('brand')) +
                (isRunning ? ' <span class="tm-label">(' + escapeHtml(t('generating')) + ')</span>' : '') + '</div>' +
                '<div class="tm-model">' + escapeHtml(subtitle) + '</div></div>' +
              '<button class="tm-btn" type="button" id="tm-lang-btn">' + (prefs.language === 'en' ? '中文' : 'EN') + '</button>' +
            '</div>' +
            '<div class="tm-grid">' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('latestSpeed')) + '</div><div class="tm-kpi-v">' + (conv && conv.latestTps != null ? Number(conv.latestTps).toFixed(1) + ' ' + escapeHtml(t('speedUnit')) : '--') + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('sessionSpeed')) + '</div><div class="tm-kpi-v">' + (conv && conv.tps != null ? Number(conv.tps).toFixed(1) + ' ' + escapeHtml(t('speedUnit')) : '--') + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('ttft')) + '</div><div class="tm-kpi-v">' + (conv && conv.ttftSeconds != null ? Number(conv.ttftSeconds).toFixed(2) + 's' : '--') + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('cacheHit')) + '</div><div class="tm-kpi-v">' + escapeHtml(fmtPct(cacheVal)) + '</div></div>' +
            '</div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('sparklineTitle')) + '</span><span>' + safeInt(conv && conv.measuredRequests) + ' ' + escapeHtml(t('requests')) + '</span></div>' +
              buildSparklineSvg(conv && conv.sparkline) +
            '</div>' +
            '<div class="tm-sec"><div class="tm-rows">' +
              '<div class="tm-row"><span>' + escapeHtml(t('uncachedIn')) + '</span><span>' + escapeHtml(fmtTokens(conv && conv.tokens && conv.tokens.uncachedInput)) + '</span></div>' +
              '<div class="tm-row"><span>' + escapeHtml(t('cacheRead')) + '</span><span>' + escapeHtml(fmtTokens(conv && conv.tokens && conv.tokens.cacheRead)) + '</span></div>' +
              '<div class="tm-row"><span>' + escapeHtml(t('responseOut')) + '</span><span>' + escapeHtml(fmtTokens(conv && conv.tokens && conv.tokens.responseOutput)) + '</span></div>' +
              '<div class="tm-row"><span>' + escapeHtml(t('thinkingOut')) + '</span><span>' + escapeHtml(fmtTokens(conv && conv.tokens && conv.tokens.thinkingOutput)) + '</span></div>' +
              '<div class="tm-row"><span>' + escapeHtml(t('today')) + '</span><span>' + escapeHtml(fmtTokens(usage && usage.todayTokens)) + '</span></div>' +
              '<div class="tm-row"><span>' + escapeHtml(t('month')) + '</span><span>' + escapeHtml(fmtTokens(usage && usage.monthTokens)) + '</span></div>' +
            '</div></div>' +
            (qHtml ? '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('quotaTitle')) + '</span></div>' + qHtml + '</div>' : '') +
            '<div class="tm-foot">' +
              '<span class="tm-label">' + (conv && conv.context ? escapeHtml(fmtTokens(conv.context.usedTokens) + ' / ' + fmtTokens(conv.context.maxTokens)) : '') + '</span>' +
              '<button class="tm-link" type="button" id="tm-open-modal">' + escapeHtml(t('openStats')) + '</button>' +
            '</div>';

          var langBtn = shadow.getElementById('tm-lang-btn');
          if (langBtn) langBtn.onclick = function(ev) {
            if (!ev || ev.isTrusted !== true) return;
            void updatePrefs({ language: state.prefs.language === 'en' ? 'zh-CN' : 'en' });
          };
          var openBtn = shadow.getElementById('tm-open-modal');
          if (openBtn) openBtn.onclick = function(ev) {
            if (!ev || ev.isTrusted !== true) return;
            clearTimeout(state.hoverTimer);
            state.popoverOpen = false;
            state.pinned = false;
            state.modalOpen = true;
            renderBar();
            renderModal();
          };
          positionPopover();
        }
      }
    }

    function renderModal() {
      if (!state.modalOpen) {
        if (modalHost) { modalHost.remove(); modalHost = null; modalShadow = null; }
        return;
      }
      if (!modalHost) {
        modalHost = document.createElement('div');
        modalHost.id = MODAL_ID;
        modalShadow = modalHost.attachShadow({ mode: 'closed' });
        document.body.appendChild(modalHost);
      }
      modalHost.setAttribute('data-theme', state.dark ? 'dark' : 'light');

      var usage = (state.snapshot && state.snapshot.usage) || { days: [], modelRank: [] };
      var dayMap = Object.create(null);
      (usage.days || []).forEach(function(d) {
        if (d && d.date) dayMap[d.date] = safeInt(d.total);
      });

      // 按当前可见的近 112 天窗口峰值计算热力图色阶，不被老峰值压暗
      var now = new Date();
      var visibleCells = [];
      var visibleMax = 1;
      for (var w = 15; w >= 0; w--) {
        var col = [];
        for (var r = 6; r >= 0; r--) {
          var dt = new Date(now);
          dt.setDate(dt.getDate() - (w * 7 + r));
          var key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
          var val = dayMap[key] || 0;
          if (val > visibleMax) visibleMax = val;
          col.push({ key: key, val: val });
        }
        visibleCells.push(col);
      }

      var colsHtml = visibleCells.map(function(col) {
        return '<div class="tm-heat-col">' + col.map(function(cell) {
          var lvl = cell.val <= 0 ? '' : cell.val > visibleMax * 0.7 ? 'l4' : cell.val > visibleMax * 0.4 ? 'l3' : cell.val > visibleMax * 0.15 ? 'l2' : 'l1';
          return '<div class="tm-cell ' + lvl + '" title="' + escapeHtml(cell.key + ': ' + fmtTokens(cell.val) + ' tokens') + '"></div>';
        }).join('') + '</div>';
      }).join('');

      var rankRows = (usage.modelRank || []).map(function(m) {
        return '<tr><td>' + escapeHtml(m.model) + '</td><td>' + escapeHtml(fmtTokens(m.totalTokens)) + '</td><td>' + escapeHtml(fmtTokens(m.outputTokens)) +
          '</td><td>' + (m.avgTps != null ? Number(m.avgTps).toFixed(1) + ' ' + escapeHtml(t('speedUnit')) : '--') + '</td><td>' + safeInt(m.requests) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="tm-empty">' + escapeHtml(t('noData')) + '</td></tr>';

      var toggles = [
        ['showSpeed', t('optSpeed')],
        ['showCache', t('optCache')],
        ['showContext', t('optContext')],
        ['showQuota', t('optQuota')],
        ['showToday', t('optToday')],
      ].map(function(pair) {
        var checked = state.prefs[pair[0]] ? ' checked' : '';
        return '<label class="tm-toggle"><input type="checkbox" data-pref-key="' + escapeHtml(pair[0]) + '"' + checked + '/>' + escapeHtml(pair[1]) + '</label>';
      }).join('');

      modalShadow.innerHTML =
        '<style>' + modalStyles() + '</style>' +
        '<div class="tm-backdrop" id="tm-backdrop" role="dialog" aria-modal="true">' +
          '<div class="tm-modal">' +
            '<div class="tm-mhead"><div class="tm-mtitle">' + escapeHtml(t('statsTitle')) + '</div>' +
              '<button class="tm-btn" type="button" id="tm-close-modal">' + escapeHtml(t('close')) + '</button></div>' +
            '<div class="tm-summary">' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('today')) + '</div><div class="tm-kpi-v">' + escapeHtml(fmtTokens(usage.todayTokens)) + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('week')) + '</div><div class="tm-kpi-v">' + escapeHtml(fmtTokens(usage.weekTokens)) + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('month')) + '</div><div class="tm-kpi-v">' + escapeHtml(fmtTokens(usage.monthTokens)) + '</div></div>' +
              '<div class="tm-kpi"><div class="tm-kpi-k">' + escapeHtml(t('lifetime')) + '</div><div class="tm-kpi-v">' + escapeHtml(fmtTokens(usage.totalTokens)) + '</div></div>' +
            '</div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('heatmapTitle')) + '</span></div><div class="tm-heat">' + colsHtml + '</div></div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('modelRankTitle')) + '</span></div>' +
              '<table class="tm-table"><thead><tr><th>' + escapeHtml(t('colModel')) + '</th><th>' + escapeHtml(t('colTotal')) + '</th><th>' + escapeHtml(t('colOutput')) + '</th><th>' + escapeHtml(t('colAvgTps')) + '</th><th>' + escapeHtml(t('colReq')) + '</th></tr></thead><tbody>' + rankRows + '</tbody></table></div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('customizeTitle')) + '</span></div><div class="tm-toggles">' + toggles + '</div></div>' +
          '</div>' +
        '</div>';

      modalShadow.getElementById('tm-close-modal').onclick = function() { state.modalOpen = false; renderModal(); };
      modalShadow.getElementById('tm-backdrop').onclick = function(e) {
        if (e.target && e.target.id === 'tm-backdrop') { state.modalOpen = false; renderModal(); }
      };
      modalShadow.querySelectorAll('input[data-pref-key]').forEach(function(inp) {
        inp.onchange = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          var patch = {};
          patch[inp.getAttribute('data-pref-key')] = Boolean(inp.checked);
          void updatePrefs(patch);
        };
      });
    }

    async function updatePrefs(patch) {
      try {
        if (window.__agTokenMeterApi) {
          var next = await window.__agTokenMeterApi.setPrefs(patch);
          if (next && !next.error) {
            state.prefs = Object.assign({}, state.prefs, next);
            state.confirmedPrefVersion = Math.max(state.confirmedPrefVersion, safeInt(next.version));
          }
        }
      } catch {}
      renderBar();
      if (state.modalOpen) renderModal();
    }

    function ensureMounted() {
      if (state.disposed) return;
      var container = findComposerContainer();
      if (!container) {
        if (hostEl && hostEl.isConnected) hostEl.remove();
        return;
      }
      if (hostEl && hostEl.isConnected && container.contains(hostEl)) return;

      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.id = HOST_ID;
        shadow = hostEl.attachShadow({ mode: 'closed' });
        shadow.innerHTML =
          '<style>' + baseStyles() + '</style>' +
          '<div class="tm-bar-wrap" id="tm-wrap"><div class="tm-chips" id="tm-chips"></div><div class="tm-popover" id="tm-popover"></div></div>';

        var wrap = shadow.getElementById('tm-wrap');
        wrap.addEventListener('mouseenter', function() {
          clearTimeout(state.hoverTimer);
          state.popoverOpen = true;
          renderBar();
        });
        wrap.addEventListener('mouseleave', function() {
          if (state.pinned) return;
          clearTimeout(state.hoverTimer);
          state.hoverTimer = setTimeout(function() {
            state.popoverOpen = false;
            renderBar();
          }, 200);
        });
        wrap.addEventListener('click', function(e) {
          if (e.target && e.target.closest && e.target.closest('[data-tm-trigger]')) {
            clearTimeout(state.hoverTimer);
            state.pinned = !state.pinned;
            state.popoverOpen = state.pinned;
            renderBar();
          }
        });
      }

      container.appendChild(hostEl);
      renderBar();
    }

    async function refresh() {
      if (state.disposed || !window.__agTokenMeterApi) return;
      ensureMounted();
      var cid = detectConversationId();
      if (cid !== state.lastCid) {
        state.lastCid = cid;
        state.requestSeq++;
        // 切换会话时立即清空旧会话快照，绝不在新会话短暂展示上一条对话数据
        if (state.snapshot) state.snapshot = Object.assign({}, state.snapshot, { conversation: null, conversationUnavailable: !cid });
        renderBar();
      }
      if (!cid) return;
      var mySeq = ++state.requestSeq;
      try {
        var snap = await window.__agTokenMeterApi.getSnapshot(cid);
        // 双重核验请求代次与当前会话 ID，丢弃过期或跨会话回包
        if (state.disposed || mySeq !== state.requestSeq || cid !== state.lastCid) return;
        if (snap && snap.disabled) {
          dispose();
          return;
        }
        if (snap) {
          state.snapshot = snap;
          if (snap.preferences && safeInt(snap.preferences.version) >= state.confirmedPrefVersion) {
            state.prefs = Object.assign({}, state.prefs, snap.preferences);
            state.confirmedPrefVersion = safeInt(snap.preferences.version);
          }
          renderBar();
          if (state.modalOpen) renderModal();
        }
      } catch {}
    }

    function onDocClick(e) {
      if (!state.pinned || !hostEl) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(hostEl)) {
        state.pinned = false;
        state.popoverOpen = false;
        renderBar();
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        if (state.modalOpen) {
          state.modalOpen = false;
          renderModal();
        } else if (state.popoverOpen) {
          state.pinned = false;
          state.popoverOpen = false;
          renderBar();
        }
      }
    }

    function onViewportChange() {
      if (state.popoverOpen) positionPopover();
    }

    function dispose() {
      state.disposed = true;
      state.requestSeq++;
      clearInterval(pollTimer);
      clearTimeout(mountDebounce);
      clearTimeout(state.hoverTimer);
      try { observer && observer.disconnect(); } catch {}
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
      if (modalHost) { modalHost.remove(); modalHost = null; modalShadow = null; }
      delete window.__agTokenMeterMounted;
      delete window.__agTokenMeterDispose;
    }

    window.__agTokenMeterDispose = dispose;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);

    function boot() {
      if (state.disposed) return;
      observer = new MutationObserver(function() {
        if (mountDebounce) return;
        mountDebounce = setTimeout(function() {
          mountDebounce = null;
          ensureMounted();
        }, 220);
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      ensureMounted();
      window.__agTokenMeterMounted = true;
      void refresh();
      pollTimer = setInterval(function() { void refresh(); }, 2500);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  })(${dictJson});`;
}
