/**
 * 隔离世界运行的 Shadow DOM 底部状态条脚本生成器。
 *
 * 核心特性：
 * 1. 三套精选零 AI 味视觉主题（swiss 瑞士精密 / glass 液态磨砂 / mono 极客终端），浅深色自适应；
 * 2. 底部状态条全透明无边框、原地骨架复用更新（上下文圆环 0–100% 无级跟进 + 四角星连续不中断）；
 * 3. 左 5h / 右周额度（100/100）双轨进度条 + 时间基准节奏刻度线（Pace Tick）；
 * 4. Prompt Cache 保鲜度、思考占比、上下文剩余轮次与一键复制脱敏摘要；
 * 5. 安全边界：Isolated World + Closed Shadow DOM + requestSeq 防串会话 + e.isTrusted 校验。
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
    var THEMES = ['swiss', 'glass', 'mono'];

    var state = {
      disposed: false,
      snapshot: null,
      prefs: { language: 'zh-CN', theme: 'swiss', showSpeed: true, showCache: true, showContext: true, showQuota: true, showToday: false, showMonth: true, version: 0 },
      confirmedPrefVersion: 0,
      popoverOpen: false,
      pinned: false,
      modalOpen: false,
      dark: false,
      lastCid: null,
      barLayoutKey: '',
      copiedUntil: 0,
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

    function currentStyle() {
      var th = state.prefs && state.prefs.theme;
      return THEMES.indexOf(th) >= 0 ? th : 'swiss';
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

    function fmtPctNum(frac) {
      if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--';
      return String(Math.round(Math.max(0, Math.min(1, frac)) * 100));
    }

    function resolveQuotaKind(q) {
      if (!q) return null;
      if (q.windowKind === '5h' || q.windowKind === 'week') return q.windowKind;
      if (q.resetTime) {
        var ms = Date.parse(q.resetTime) - Date.now();
        if (Number.isFinite(ms) && ms > 0) {
          if (ms <= 5.5 * 3600000) return '5h';
          if (ms <= 8 * 86400000) return 'week';
        }
      }
      return null;
    }

    function getQuotaPairParts(pair, fallbackQuota) {
      var p = pair;
      if (!p && fallbackQuota) {
        var kind = resolveQuotaKind(fallbackQuota);
        p = {
          fiveHourFraction: fallbackQuota.fiveHour ? fallbackQuota.fiveHour.remainingFraction : kind === '5h' ? fallbackQuota.remainingFraction : null,
          weeklyFraction: fallbackQuota.weekly ? fallbackQuota.weekly.remainingFraction : kind === 'week' ? fallbackQuota.remainingFraction : null,
          fallbackFraction: fallbackQuota.remainingFraction,
        };
      }
      if (!p) return { single: '--' };
      var has5h = typeof p.fiveHourFraction === 'number' && Number.isFinite(p.fiveHourFraction);
      var hasWk = typeof p.weeklyFraction === 'number' && Number.isFinite(p.weeklyFraction);
      if (has5h || hasWk) {
        return {
          left: fmtPctNum(has5h ? p.fiveHourFraction : null),
          right: fmtPctNum(hasWk ? p.weeklyFraction : null),
        };
      }
      return { single: fmtPct(p.fallbackFraction) };
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

    function getCacheFreshness(lastRequestIso) {
      if (!lastRequestIso) return null;
      var ms = Date.now() - Date.parse(lastRequestIso);
      if (!Number.isFinite(ms) || ms < 0) return null;
      var sec = Math.floor(ms / 1000);
      var ageText = sec < 60 ? sec + 's' : sec < 3600 ? Math.floor(sec / 60) + 'm' : Math.floor(sec / 3600) + 'h';
      if (sec <= 270) return { cls: 'warm', label: t('cacheWarm') + ' ' + ageText };
      if (sec <= 600) return { cls: 'cool', label: t('cacheCooling') + ' ' + ageText };
      return { cls: 'cold', label: t('cacheCold') + ' ' + ageText };
    }

    function buildCopySummaryText() {
      var snap = state.snapshot || {};
      var conv = snap.conversation || {};
      var usage = snap.usage || {};
      var leadQ = (snap.quotas && snap.quotas[0]) || null;
      var qParts = getQuotaPairParts(snap.quotaPair, leadQ);
      var qText = qParts.single !== undefined ? qParts.single : (qParts.left + '/' + qParts.right);
      var parts = ['✦ TokenMeter'];
      if (conv.model) parts.push(String(conv.model));
      if (conv.latestTps != null) parts.push(Number(conv.latestTps).toFixed(1) + ' tok/s' + (conv.tps != null ? ' (avg ' + Number(conv.tps).toFixed(1) + ')' : ''));
      if (conv.cacheHitRate != null) parts.push('Cache ' + fmtPct(conv.cacheHitRate));
      if (conv.context && conv.context.usedFraction != null) parts.push('Ctx ' + fmtPct(conv.context.usedFraction));
      if (qText !== '--') parts.push('Quota ' + qText);
      if (usage.todayTokens) parts.push('Today ' + fmtTokens(usage.todayTokens));
      if (usage.monthTokens) parts.push('Month ' + fmtTokens(usage.monthTokens));
      return parts.join(' | ');
    }

    function copyTextSafe(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          void navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }

    function detectDarkTheme() {
      try {
        if (document.documentElement.classList.contains('dark') || document.body?.classList?.contains('dark')) return true;
        var el = document.body || document.documentElement;
        var bg = el ? getComputedStyle(el).backgroundColor : '';
        var m = bg && bg.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/);
        if (m) {
          var alpha = m[4] === undefined ? 1 : Number(m[4]);
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

    /**
     * 优先定位输入框底栏（.agy-composer-footer）中右侧操作组之前，实现与「极速 ▾」同行齐平内嵌；
     * 窗口过窄（< 620px）或未找到底栏结构时自动回退至输入框下方，防止挤压按钮。
     */
    function findMountAnchor() {
      var box = findComposerContainer();
      if (!box) return null;

      var footer = box.querySelector('.agy-composer-footer');
      if (!footer) {
        var permBtn = box.querySelector('[data-testid="permissions-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]');
        if (permBtn) {
          var p = permBtn.parentElement;
          for (var d = 0; d < 4 && p && p !== box; d++) {
            var cs = getComputedStyle(p);
            if (cs.display === 'flex' && cs.flexDirection === 'row' && p.children.length >= 2) {
              footer = p;
              break;
            }
            p = p.parentElement;
          }
        }
      }

      if (footer && isVisible(footer)) {
        var fw = footer.getBoundingClientRect().width;
        var rightGroup = null;
        var anchorTrigger = footer.querySelector('[data-testid="permissions-selector-trigger"], [data-testid="send-button"], [data-testid="stop-button"]');
        if (anchorTrigger) {
          var cur = anchorTrigger;
          while (cur && cur.parentElement && cur.parentElement !== footer) {
            cur = cur.parentElement;
          }
          if (cur && cur.parentElement === footer) rightGroup = cur;
        }
        if (!rightGroup && footer.children.length >= 2) {
          rightGroup = footer.lastElementChild;
        }
        var enabledCount =
          (state.prefs.showSpeed !== false ? 1 : 0) +
          (state.prefs.showCache !== false ? 1 : 0) +
          (state.prefs.showContext !== false ? 1 : 0) +
          (state.prefs.showQuota !== false ? 1 : 0) +
          (state.prefs.showToday === true ? 1 : 0) +
          (state.prefs.showMonth === true ? 1 : 0);
        var minInlineWidth = enabledCount >= 6 ? 760 : enabledCount >= 5 ? 680 : 620;
        if (rightGroup && fw >= minInlineWidth) {
          return { parent: footer, before: rightGroup, placement: 'inline-footer' };
        }
      }

      return { parent: box, before: null, placement: 'below' };
    }

    function buildSparkleIcon(cls, dual) {
      if (dual) {
        return '<svg class="tm-star tm-star-dual ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path class="tm-star-main" d="M10.5 2.5 C11.4 8.3 13.7 10.6 19.5 11.5 C13.7 12.4 11.4 14.7 10.5 20.5 C9.6 14.7 7.3 12.4 1.5 11.5 C7.3 10.6 9.6 8.3 10.5 2.5 Z"/>' +
          '<path class="tm-star-sub" d="M19 2.2 C19.4 4.3 20.2 5.1 22.3 5.5 C20.2 5.9 19.4 6.7 19 8.8 C18.6 6.7 17.8 5.9 15.7 5.5 C17.8 5.1 18.6 4.3 19 2.2 Z"/>' +
        '</svg>';
      }
      return '<svg class="tm-star ' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path class="tm-star-main" d="M12 1.8 C13.1 8.4 15.6 10.9 22.2 12 C15.6 13.1 13.1 15.6 12 22.2 C10.9 15.6 8.4 13.1 1.8 12 C8.4 10.9 10.9 8.4 12 1.8 Z"/>' +
      '</svg>';
    }

    var CTX_RING_R = 5.6;
    var CTX_RING_CIRC = 2 * Math.PI * CTX_RING_R;
    var CTX_COLOR_STOPS = [
      [0.0, 59, 130, 246],
      [0.48, 37, 99, 235],
      [0.72, 217, 119, 6],
      [0.90, 220, 38, 38],
      [1.0, 185, 28, 28],
    ];

    function interpCtxColor(frac) {
      var f = Math.max(0, Math.min(1, Number(frac) || 0));
      for (var i = 0; i < CTX_COLOR_STOPS.length - 1; i++) {
        var a = CTX_COLOR_STOPS[i];
        var b = CTX_COLOR_STOPS[i + 1];
        if (f <= b[0]) {
          var k = (f - a[0]) / Math.max(1e-6, b[0] - a[0]);
          return 'rgb(' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ',' + Math.round(a[3] + (b[3] - a[3]) * k) + ')';
        }
      }
      return 'rgb(185,28,28)';
    }

    function buildContextRingSvg(frac, roleAttr) {
      var hasVal = typeof frac === 'number' && Number.isFinite(frac);
      var clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
      var dashOffset = CTX_RING_CIRC * (1 - clamped);
      var stroke = interpCtxColor(clamped);
      var attr = roleAttr ? ' data-tm-ring="' + roleAttr + '"' : '';
      return '<svg class="tm-ring" viewBox="0 0 16 16" aria-hidden="true"' + attr + '>' +
        '<circle cx="8" cy="8" r="' + CTX_RING_R + '" fill="none" stroke="var(--tm-ring-track)" stroke-width="1.85"/>' +
        '<circle class="tm-ring-val" cx="8" cy="8" r="' + CTX_RING_R + '" fill="none" stroke="' + stroke + '" stroke-width="1.85" stroke-linecap="round" stroke-dasharray="' + CTX_RING_CIRC.toFixed(3) + '" stroke-dashoffset="' + dashOffset.toFixed(3) + '" stroke-opacity="' + (clamped > 0 ? '1' : '0') + '" transform="rotate(-90 8 8)"/>' +
      '</svg>';
    }

    function syncContextRingEl(svgEl, frac) {
      if (!svgEl) return;
      var hasVal = typeof frac === 'number' && Number.isFinite(frac);
      var clamped = hasVal ? Math.max(0, Math.min(1, frac)) : 0;
      var dashOffset = CTX_RING_CIRC * (1 - clamped);
      var arc = svgEl.querySelector('.tm-ring-val');
      if (arc) {
        arc.setAttribute('stroke-dashoffset', dashOffset.toFixed(3));
        arc.setAttribute('stroke-opacity', clamped > 0 ? '1' : '0');
        arc.setAttribute('stroke', interpCtxColor(clamped));
      }
    }

    function buildSparklineSvg(points) {
      if (!Array.isArray(points) || points.length < 2) {
        return '<div class="tm-empty">' + escapeHtml(t('noData')) + '</div>';
      }
      var w = 276, h = 42, padX = 3, padY = 6;
      var vals = points.map(function(p) { var v = Number(p && p.tps); return Number.isFinite(v) && v >= 0 ? v : 0; });
      var min = Math.min.apply(null, vals);
      var max = Math.max.apply(null, vals);
      var span = Math.max(1, max - min);
      var pts = vals.map(function(v, idx) {
        return [
          padX + (idx / (vals.length - 1)) * (w - padX * 2),
          h - padY - ((v - min) / span) * (h - padY * 2)
        ];
      });
      var coords = pts.map(function(p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); });
      var area = padX + ',' + (h - 2) + ' ' + coords.join(' ') + ' ' + (w - padX) + ',' + (h - 2);
      var last = pts[pts.length - 1];
      var midY = (h / 2).toFixed(1);
      return '<svg class="tm-spark" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' +
        '<defs><linearGradient id="tm-sp-area" x1="0" y1="0" x2="0" y2="' + h + '" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0%" stop-color="currentColor" stop-opacity="0.11"/>' +
          '<stop offset="100%" stop-color="currentColor" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        '<line x1="0" y1="' + midY + '" x2="' + w + '" y2="' + midY + '" stroke="var(--tm-hairline)" stroke-dasharray="2 3"/>' +
        '<polygon points="' + area + '" fill="url(#tm-sp-area)"/>' +
        '<polyline points="' + coords.join(' ') + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.6" fill="var(--tm-accent)" stroke="var(--tm-card)" stroke-width="1.4"/>' +
      '</svg>';
    }

    function buildTokenBreakdownHtml(conv) {
      var tokens = conv && conv.tokens;
      var uIn = safeInt(tokens && tokens.uncachedInput);
      var cRead = safeInt(tokens && tokens.cacheRead);
      var rOut = safeInt(tokens && tokens.responseOutput);
      var tOut = safeInt(tokens && tokens.thinkingOutput);
      var sum = uIn + cRead + rOut + tOut;
      var wIn = sum > 0 ? (uIn / sum) * 100 : 0;
      var wCache = sum > 0 ? (cRead / sum) * 100 : 0;
      var wResp = sum > 0 ? (rOut / sum) * 100 : 0;
      var wThink = sum > 0 ? (tOut / sum) * 100 : 0;
      var fresh = getCacheFreshness(conv && conv.lastRequestTime);
      var thinkPct = conv && typeof conv.thinkingRatio === 'number' ? Math.round(conv.thinkingRatio * 100) + '%' : null;

      var metaLine = '';
      if (fresh || thinkPct || cRead > 0) {
        metaLine = '<div class="tm-micro-row">' +
          (fresh ? '<span class="tm-fresh ' + fresh.cls + '"><i></i>' + escapeHtml(fresh.label) + (cRead > 0 ? ' · ' + escapeHtml(t('cacheSaved')) + ' ' + escapeHtml(fmtTokens(cRead)) : '') + '</span>' : '<span></span>') +
          (thinkPct ? '<span class="tm-think-tag">' + escapeHtml(t('thinkShare')) + ' ' + escapeHtml(thinkPct) + '</span>' : '') +
        '</div>';
      }

      return metaLine +
        '<div class="tm-stack" aria-hidden="true">' +
          '<span class="tm-st-cache" style="width:' + wCache.toFixed(1) + '%"></span>' +
          '<span class="tm-st-in" style="width:' + wIn.toFixed(1) + '%"></span>' +
          '<span class="tm-st-resp" style="width:' + wResp.toFixed(1) + '%"></span>' +
          '<span class="tm-st-think" style="width:' + wThink.toFixed(1) + '%"></span>' +
        '</div>' +
        '<div class="tm-legend">' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-cache"></i>' + escapeHtml(t('cacheRead')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(cRead)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-in"></i>' + escapeHtml(t('uncachedIn')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(uIn)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-resp"></i>' + escapeHtml(t('responseOut')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(rOut)) + '</span></div>' +
          '<div class="tm-leg-item"><span class="tm-leg-k"><i class="tm-sw tm-st-think"></i>' + escapeHtml(t('thinkingOut')) + '</span><span class="tm-leg-v">' + escapeHtml(fmtTokens(tOut)) + '</span></div>' +
        '</div>';
    }

    /* 双轨进度条 + 垂直时间基准节奏刻度线（Pace Tick） */
    function renderQuotaSubBar(tag, frac, resetIso, pacing) {
      var pct = Math.round(Math.max(0, Math.min(1, Number(frac) || 0)) * 100);
      var status = pacing && pacing.status;
      var cls = (pct <= 15 || status === 'burn') ? 'danger' : (pct <= 35 || status === 'fast') ? 'warn' : '';
      var tickHtml = '';
      if (pacing && typeof pacing.timeRemainingFraction === 'number' && Number.isFinite(pacing.timeRemainingFraction)) {
        var tickPos = Math.max(2, Math.min(98, Math.round(pacing.timeRemainingFraction * 100)));
        tickHtml = '<span class="tm-pace-tick" style="left:' + tickPos + '%" title="' + escapeHtml(t('paceLegend')) + '"></span>';
      }
      return '<div class="tm-qsub">' +
        '<span class="tm-qtag">' + escapeHtml(tag) + '</span>' +
        '<div class="tm-qtrack"><div class="tm-qbar"><div class="tm-qfill ' + cls + '" style="width:' + pct + '%"></div></div>' + tickHtml + '</div>' +
        '<span class="tm-qsub-val"><b>' + pct + '%</b><em>' + escapeHtml(fmtCountdown(resetIso)) + '</em></span>' +
      '</div>';
    }

    function baseStyles() {
      return \`
        :host {
          --tm-card: #ffffff;
          --tm-elev: #f4f4f5;
          --tm-border: rgba(24,24,27,0.10);
          --tm-hairline: rgba(24,24,27,0.075);
          --tm-text: #18181b;
          --tm-sub: #52525b;
          --tm-muted: #71717a;
          --tm-faint: #a1a1aa;
          --tm-hover: rgba(24,24,27,0.055);
          --tm-sep: rgba(24,24,27,0.16);
          --tm-ring-track: rgba(24,24,27,0.13);
          --tm-accent: #2563eb;
          --tm-ink-bar: #18181b;
          --tm-ok: #16a34a;
          --tm-warn: #d97706;
          --tm-danger: #dc2626;
          --tm-radius: 11px;
          --tm-blur: none;
          --tm-shadow: 0 18px 44px -12px rgba(24,24,27,0.16), 0 2px 6px rgba(24,24,27,0.06);
          --tm-mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", "Consolas", monospace;
          --tm-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-family: var(--tm-font);
          font-size: 11.5px;
          color: var(--tm-text);
          display: block;
          -webkit-font-smoothing: antialiased;
        }
        :host([data-theme="dark"]) {
          --tm-card: #121214;
          --tm-elev: #1c1c20;
          --tm-border: rgba(255,255,255,0.09);
          --tm-hairline: rgba(255,255,255,0.065);
          --tm-text: #f4f4f5;
          --tm-sub: #a1a1aa;
          --tm-muted: #8a8a93;
          --tm-faint: #52525b;
          --tm-hover: rgba(255,255,255,0.075);
          --tm-sep: rgba(255,255,255,0.16);
          --tm-ring-track: rgba(255,255,255,0.15);
          --tm-accent: #60a5fa;
          --tm-ink-bar: #e4e4e7;
          --tm-ok: #22c55e;
          --tm-warn: #f59e0b;
          --tm-danger: #ef4444;
          --tm-shadow: 0 22px 48px -12px rgba(0,0,0,0.68), 0 0 0 1px rgba(255,255,255,0.04) inset;
        }
        /* 主题 2：液态磨砂 Glass（macOS 原生毛玻璃 HUD 质感） */
        :host([data-style="glass"]) {
          --tm-card: rgba(255,255,255,0.78);
          --tm-elev: rgba(24,24,27,0.055);
          --tm-border: rgba(255,255,255,0.68);
          --tm-hairline: rgba(24,24,27,0.08);
          --tm-radius: 14px;
          --tm-blur: blur(22px) saturate(180%);
          --tm-shadow: 0 20px 50px -14px rgba(15,23,42,0.18), 0 0 0 1px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.85);
        }
        :host([data-theme="dark"][data-style="glass"]) {
          --tm-card: rgba(24,24,28,0.76);
          --tm-elev: rgba(255,255,255,0.075);
          --tm-border: rgba(255,255,255,0.14);
          --tm-hairline: rgba(255,255,255,0.08);
          --tm-shadow: 0 24px 56px -12px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.12);
        }
        /* 主题 3：极客终端 Mono（全等宽精密仪器 + 经典翠绿磷光点缀） */
        :host([data-style="mono"]) {
          --tm-font: var(--tm-mono);
          --tm-card: #f6f8f6;
          --tm-elev: #e9eee9;
          --tm-border: rgba(16,32,24,0.18);
          --tm-hairline: rgba(16,32,24,0.10);
          --tm-accent: #059669;
          --tm-ink-bar: #059669;
          --tm-radius: 5px;
          --tm-shadow: 0 14px 32px -10px rgba(16,32,24,0.16);
        }
        :host([data-theme="dark"][data-style="mono"]) {
          --tm-card: #0c100e;
          --tm-elev: #151d19;
          --tm-border: rgba(16,185,129,0.22);
          --tm-hairline: rgba(16,185,129,0.11);
          --tm-text: #e6f4ec;
          --tm-sub: #9eb7a9;
          --tm-muted: #6f8a7c;
          --tm-faint: #465d51;
          --tm-accent: #10b981;
          --tm-ink-bar: #10b981;
          --tm-shadow: 0 20px 44px -10px rgba(0,0,0,0.75);
        }

        @keyframes tm-star-turn {
          0% { transform: rotate(0deg) scale(0.96); }
          50% { transform: rotate(45deg) scale(1.06); }
          100% { transform: rotate(90deg) scale(0.96); }
        }
        @keyframes tm-star-blink {
          0%, 100% { opacity: 0.45; transform: scale(0.86); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        .tm-bar-wrap { position: relative; display: flex; align-items: center; padding: 3px 6px 2px; user-select: none; }
        :host([data-placement="inline-footer"]) {
          display: inline-flex;
          align-items: center;
          flex-shrink: 0;
          height: 28px;
          margin-right: 6px;
        }
        :host([data-placement="inline-footer"]) .tm-bar-wrap {
          padding: 0 2px;
          height: 28px;
          display: inline-flex;
          align-items: center;
        }
        :host([data-placement="inline-footer"]) .tm-chips {
          flex-wrap: nowrap;
        }
        .tm-chips { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 1px; }
        .tm-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; border-radius: 5px; background: transparent; border: none; color: var(--tm-muted); cursor: pointer; transition: background .14s ease, color .14s ease; line-height: 17px; font-size: 11.5px; font-variant-numeric: tabular-nums; font-family: inherit; }
        .tm-chip:hover, .tm-chip:focus-visible { background: var(--tm-hover); color: var(--tm-text); outline: none; }
        .tm-sep { width: 1px; height: 9px; background: var(--tm-sep); margin: 0 2px; display: inline-block; flex-shrink: 0; pointer-events: none; }
        .tm-star { width: 12px; height: 12px; display: inline-block; flex-shrink: 0; transition: transform .22s ease; }
        .tm-star-dual { width: 15px; height: 15px; }
        .tm-star .tm-star-main { fill: var(--tm-text); }
        .tm-star .tm-star-sub { fill: var(--tm-accent); }
        .tm-star.live .tm-star-main { fill: var(--tm-accent); }
        .tm-star.idle .tm-star-main { fill: var(--tm-sub); }
        .tm-star.off .tm-star-main, .tm-star.off .tm-star-sub { fill: var(--tm-faint); opacity: 0.55; }
        .tm-star:not(.tm-star-dual).live { animation: tm-star-turn 3.4s ease-in-out infinite; }
        .tm-star-dual.live .tm-star-main { transform-box: fill-box; transform-origin: center; animation: tm-star-turn 3.4s ease-in-out infinite; }
        .tm-star-dual.live .tm-star-sub { transform-box: fill-box; transform-origin: center; animation: tm-star-blink 2s ease-in-out infinite; }
        .tm-chip:hover .tm-star.idle { transform: rotate(22deg); }
        .tm-chip:hover .tm-star.idle .tm-star-main { fill: var(--tm-accent); }
        @media (prefers-reduced-motion: reduce) {
          .tm-star:not(.tm-star-dual).live, .tm-star-dual.live .tm-star-main, .tm-star-dual.live .tm-star-sub { animation: none; }
        }
        .tm-ring { width: 12.5px; height: 12.5px; display: inline-block; flex-shrink: 0; }
        .tm-ring-val { transition: stroke-dashoffset .45s cubic-bezier(0.22, 1, 0.36, 1), stroke .45s ease, stroke-opacity .25s ease; }
        .tm-label { color: var(--tm-muted); font-size: 11px; font-weight: 400; letter-spacing: 0.01em; }
        .tm-val { color: var(--tm-text); font-weight: 500; opacity: 0.9; letter-spacing: -0.01em; }
        .tm-chip:hover .tm-val { opacity: 1; }
        .tm-slash { color: var(--tm-faint); margin: 0 1.5px; font-weight: 400; }
        .tm-unit { color: var(--tm-faint); font-size: 10.5px; margin-left: -2px; }

        .tm-popover { position: fixed; z-index: 2147483600; width: min(322px, calc(100vw - 20px)); max-height: calc(100vh - 24px); overflow: auto; background: var(--tm-card); backdrop-filter: var(--tm-blur); -webkit-backdrop-filter: var(--tm-blur); border: 1px solid var(--tm-border); border-radius: var(--tm-radius); box-shadow: var(--tm-shadow); padding: 14px 15px 12px; box-sizing: border-box; display: none; }
        .tm-popover.open { display: block; }
        .tm-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 10px; }
        .tm-brand-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .tm-head-acts { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .tm-model { font-size: 11.5px; font-weight: 600; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 155px; letter-spacing: -0.01em; }
        .tm-status-tag { font-size: 10px; color: var(--tm-accent); font-weight: 500; flex-shrink: 0; }
        .tm-btn { border: 1px solid var(--tm-border); background: transparent; color: var(--tm-sub); border-radius: 5px; padding: 2px 6px; font-size: 10.5px; font-weight: 500; cursor: pointer; font-family: inherit; transition: border-color .14s, color .14s, background .14s; }
        .tm-btn:hover, .tm-btn:focus-visible { border-color: var(--tm-text); color: var(--tm-text); background: var(--tm-hover); outline: none; }

        .tm-hero { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
        .tm-hero-main { display: inline-flex; align-items: baseline; gap: 4px; }
        .tm-hero-num { font-size: 27px; font-weight: 650; line-height: 1; letter-spacing: -0.035em; font-variant-numeric: tabular-nums; color: var(--tm-text); }
        .tm-hero-unit { font-size: 11px; color: var(--tm-muted); font-weight: 500; }
        .tm-hero-meta { font-size: 10.5px; color: var(--tm-muted); text-align: right; font-variant-numeric: tabular-nums; line-height: 1.45; }
        .tm-hero-meta b { color: var(--tm-text); font-weight: 600; }
        .tm-spark-wrap { color: var(--tm-text); margin: 2px 0 9px; }
        .tm-spark { display: block; overflow: visible; }
        .tm-sub-strip { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--tm-hairline); border-bottom: 1px solid var(--tm-hairline); padding: 7px 0; margin-bottom: 9px; }
        .tm-sub-cell { padding: 0 8px; border-left: 1px solid var(--tm-hairline); }
        .tm-sub-cell:first-child { padding-left: 0; border-left: none; }
        .tm-sub-k { font-size: 10px; color: var(--tm-muted); margin-bottom: 2px; }
        .tm-sub-v { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--tm-text); letter-spacing: -0.015em; }
        .tm-usage-strip { display: grid; grid-template-columns: repeat(4, 1fr); padding: 2px 0; }
        .tm-usage-cell { padding: 0 7px; border-left: 1px solid var(--tm-hairline); }
        .tm-usage-cell:first-child { padding-left: 0; border-left: none; }
        .tm-usage-k { font-size: 9.5px; color: var(--tm-muted); margin-bottom: 2px; }
        .tm-usage-v { font-family: var(--tm-mono); font-size: 11.5px; font-weight: 600; color: var(--tm-text); }

        .tm-micro-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 10px; color: var(--tm-muted); margin-bottom: 5px; }
        .tm-fresh { display: inline-flex; align-items: center; gap: 4px; }
        .tm-fresh i { width: 5px; height: 5px; border-radius: 50%; display: inline-block; background: var(--tm-ok); }
        .tm-fresh.cool i { background: var(--tm-warn); }
        .tm-fresh.cold i { background: var(--tm-faint); }
        .tm-think-tag { font-family: var(--tm-mono); color: var(--tm-sub); }

        .tm-sec { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--tm-hairline); }
        .tm-sec-title { font-size: 10.5px; color: var(--tm-muted); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; font-weight: 500; gap: 6px; }
        .tm-stack { display: flex; height: 4px; border-radius: 99px; overflow: hidden; background: var(--tm-elev); gap: 1px; margin-bottom: 7px; }
        .tm-st-cache { background: var(--tm-text); opacity: 0.78; }
        .tm-st-in { background: var(--tm-accent); }
        .tm-st-resp { background: var(--tm-muted); opacity: 0.65; }
        .tm-st-think { background: var(--tm-faint); opacity: 0.55; }
        .tm-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 11px; }
        .tm-leg-item { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        .tm-leg-k { display: inline-flex; align-items: center; gap: 5px; color: var(--tm-muted); }
        .tm-leg-v { font-family: var(--tm-mono); font-size: 10.5px; font-weight: 500; color: var(--tm-text); }
        .tm-sw { width: 6px; height: 6px; border-radius: 1.5px; display: inline-block; flex-shrink: 0; }

        .tm-qitem { margin-bottom: 9px; }
        .tm-qitem:last-child { margin-bottom: 0; }
        .tm-qmeta { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; margin-bottom: 4px; gap: 6px; }
        .tm-qname { color: var(--tm-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-qright { display: inline-flex; align-items: baseline; gap: 6px; flex-shrink: 0; }
        .tm-pace-pill { font-size: 9.5px; font-weight: 500; color: var(--tm-muted); }
        .tm-pace-pill.fast { color: var(--tm-warn); }
        .tm-pace-pill.burn { color: var(--tm-danger); }
        .tm-qpair { font-family: var(--tm-mono); font-size: 11px; font-weight: 600; color: var(--tm-text); }
        .tm-qsub { display: flex; align-items: center; gap: 7px; margin-top: 4px; font-size: 10.5px; }
        .tm-qtag { width: 22px; flex-shrink: 0; font-size: 10px; color: var(--tm-muted); font-family: var(--tm-mono); }
        .tm-qtrack { position: relative; flex: 1; height: 9px; display: flex; align-items: center; }
        .tm-qbar { width: 100%; height: 3.5px; border-radius: 99px; background: var(--tm-elev); overflow: hidden; }
        .tm-qfill { height: 100%; border-radius: 99px; background: var(--tm-ink-bar); }
        .tm-qfill.warn { background: var(--tm-warn); }
        .tm-qfill.danger { background: var(--tm-danger); }
        /* 节奏时间基准竖线：一眼对照“当前剩余额度 vs 窗口剩余时间” */
        .tm-pace-tick { position: absolute; top: 0; bottom: 0; width: 1.5px; background: var(--tm-text); opacity: 0.58; border-radius: 1px; pointer-events: none; transform: translateX(-50%); }
        .tm-qsub-val { font-family: var(--tm-mono); font-size: 10px; color: var(--tm-muted); white-space: nowrap; min-width: 78px; text-align: right; display: inline-flex; justify-content: flex-end; gap: 6px; }
        .tm-qsub-val b { color: var(--tm-text); font-weight: 500; }
        .tm-qsub-val em { font-style: normal; color: var(--tm-faint); }

        .tm-foot { margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--tm-hairline); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .tm-foot-ctx { display: inline-flex; align-items: center; gap: 5px; font-family: var(--tm-mono); font-size: 10px; color: var(--tm-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tm-link { border: none; background: transparent; color: var(--tm-text); font-weight: 500; font-size: 11px; cursor: pointer; padding: 2px 0; font-family: inherit; flex-shrink: 0; transition: color .14s; }
        .tm-link:hover { color: var(--tm-accent); }
        .tm-empty { color: var(--tm-faint); font-size: 11px; text-align: center; padding: 10px 0; }
      \`;
    }

    function modalStyles() {
      return baseStyles() + \`
        .tm-backdrop { position: fixed; inset: 0; z-index: 2147483640; background: rgba(9,9,11,0.56); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 18px; }
        .tm-modal { width: min(740px, 95vw); max-height: 88vh; overflow: auto; background: var(--tm-card); backdrop-filter: var(--tm-blur); -webkit-backdrop-filter: var(--tm-blur); border: 1px solid var(--tm-border); border-radius: var(--tm-radius); box-shadow: var(--tm-shadow); padding: 20px 22px; box-sizing: border-box; }
        .tm-mhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 8px; }
        .tm-mtitle { font-size: 14.5px; font-weight: 650; display: inline-flex; align-items: center; gap: 7px; letter-spacing: -0.015em; }
        .tm-summary { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--tm-hairline); border-bottom: 1px solid var(--tm-hairline); padding: 12px 0; margin-bottom: 16px; }
        .tm-sum-cell { padding: 0 14px; border-left: 1px solid var(--tm-hairline); }
        .tm-sum-cell:first-child { padding-left: 0; border-left: none; }
        .tm-sum-k { font-size: 10.5px; color: var(--tm-muted); margin-bottom: 4px; }
        .tm-sum-v { font-size: 20px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; color: var(--tm-text); }
        .tm-heat { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; }
        .tm-heat-col { display: grid; grid-template-rows: repeat(7, 11px); gap: 3px; }
        .tm-cell { border-radius: 2px; background: var(--tm-elev); }
        .tm-cell.l1 { background: rgba(24,24,27,0.18); }
        .tm-cell.l2 { background: rgba(24,24,27,0.40); }
        .tm-cell.l3 { background: rgba(24,24,27,0.68); }
        .tm-cell.l4 { background: #18181b; }
        :host([data-theme="dark"]) .tm-cell.l1 { background: rgba(244,244,245,0.16); }
        :host([data-theme="dark"]) .tm-cell.l2 { background: rgba(244,244,245,0.34); }
        :host([data-theme="dark"]) .tm-cell.l3 { background: rgba(244,244,245,0.62); }
        :host([data-theme="dark"]) .tm-cell.l4 { background: #f4f4f5; }
        :host([data-style="mono"]) .tm-cell.l1 { background: rgba(16,185,129,0.22); }
        :host([data-style="mono"]) .tm-cell.l2 { background: rgba(16,185,129,0.44); }
        :host([data-style="mono"]) .tm-cell.l3 { background: rgba(16,185,129,0.72); }
        :host([data-style="mono"]) .tm-cell.l4 { background: #10b981; }
        .tm-table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-top: 4px; }
        .tm-table th, .tm-table td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--tm-hairline); font-variant-numeric: tabular-nums; }
        .tm-table th { color: var(--tm-muted); font-weight: 500; font-size: 10.5px; }
        .tm-table td:not(:first-child) { font-family: var(--tm-mono); font-size: 11px; }
        .tm-pref-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-top: 6px; }
        .tm-toggles { display: flex; flex-wrap: wrap; gap: 6px; }
        .tm-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--tm-border); background: transparent; color: var(--tm-muted); font-size: 11.5px; cursor: pointer; transition: all .14s ease; }
        .tm-pill input { display: none; }
        .tm-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tm-faint); transition: background .14s; }
        .tm-pill.on { border-color: var(--tm-text); color: var(--tm-text); background: var(--tm-elev); font-weight: 500; }
        .tm-pill.on .tm-pill-dot { background: var(--tm-accent); }
        .tm-seg { display: inline-flex; border: 1px solid var(--tm-border); border-radius: 7px; padding: 2px; gap: 2px; background: var(--tm-elev); }
        .tm-seg-btn { border: none; background: transparent; color: var(--tm-muted); font-size: 11px; padding: 3px 9px; border-radius: 5px; cursor: pointer; font-family: inherit; transition: all .14s; }
        .tm-seg-btn.active { background: var(--tm-card); color: var(--tm-text); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
      var pw = pop.offsetWidth || 322;
      var ph = pop.offsetHeight || 390;
      var left = Math.max(10, Math.min(vw - pw - 10, rect.left + 6));
      var top = rect.top - ph - 8;
      if (top < 10) top = Math.max(10, Math.min(vh - ph - 10, rect.bottom + 8));
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function renderBar() {
      if (!shadow || !hostEl) return;
      state.dark = detectDarkTheme();
      hostEl.setAttribute('data-theme', state.dark ? 'dark' : 'light');
      hostEl.setAttribute('data-style', currentStyle());

      var snap = state.snapshot;
      var conv = snap && snap.conversation;
      var usage = snap && snap.usage;
      var quotas = (snap && snap.quotas) || [];
      var prefs = state.prefs;

      var tpsVal = conv && (conv.latestTps != null ? conv.latestTps : conv.tps);
      var cacheVal = conv && conv.cacheHitRate;
      var ctxFrac = conv && conv.context && conv.context.usedFraction;
      var leadQuota = quotas[0] || null;
      var quotaPair = (snap && snap.quotaPair) || null;
      var hasQuota = Boolean(quotaPair || leadQuota);
      var isRunning = Boolean(conv && conv.running);
      var starCls = !snap || !snap.connected ? 'off' : isRunning ? 'live' : 'idle';
      var expanded = state.popoverOpen ? 'true' : 'false';

      var showSpeed = prefs.showSpeed !== false;
      var showCache = prefs.showCache !== false;
      var showContext = prefs.showContext !== false;
      var showQuota = prefs.showQuota !== false && hasQuota;
      var showToday = prefs.showToday === true && Boolean(usage);
      var showMonth = prefs.showMonth === true && Boolean(usage);
      var langKey = prefs.language === 'en' ? 'en' : 'zh-CN';
      var layoutKey = [langKey, showSpeed ? 1 : 0, showCache ? 1 : 0, showContext ? 1 : 0, showQuota ? 1 : 0, showToday ? 1 : 0, showMonth ? 1 : 0].join(':');

      var chipsEl = shadow.getElementById('tm-chips');
      if (chipsEl) {
        if (state.barLayoutKey !== layoutKey || !chipsEl.firstChild) {
          var barStar = buildSparkleIcon(starCls, false);
          var chipItems = [];
          if (showSpeed) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + barStar + '<span class="tm-val" data-tm-v="speed">--</span><span class="tm-unit">' + escapeHtml(t('speedUnit')) + '</span></button>');
          }
          if (showCache) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + (chipItems.length === 0 ? barStar : '') + '<span class="tm-label">' + escapeHtml(t('cacheHit')) + '</span><span class="tm-val" data-tm-v="cache">--</span></button>');
          }
          if (showContext) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + (chipItems.length === 0 ? barStar : '') + buildContextRingSvg(ctxFrac, 'bar') + '<span class="tm-label">' + escapeHtml(t('context')) + '</span><span class="tm-val" data-tm-v="ctx">--</span></button>');
          }
          if (showQuota) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1" title="' + escapeHtml(t('quotaPairTip')) + '">' + (chipItems.length === 0 ? barStar : '') + '<span class="tm-label">' + escapeHtml(t('quota')) + '</span><span class="tm-val" data-tm-v="quota"><span data-tm-q="l">--</span><span class="tm-slash">/</span><span data-tm-q="r">--</span></span></button>');
          }
          if (showToday) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + (chipItems.length === 0 ? barStar : '') + '<span class="tm-label">' + escapeHtml(t('today')) + '</span><span class="tm-val" data-tm-v="today">--</span></button>');
          }
          if (showMonth) {
            chipItems.push('<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + (chipItems.length === 0 ? barStar : '') + '<span class="tm-label">' + escapeHtml(t('month')) + '</span><span class="tm-val" data-tm-v="month">--</span></button>');
          }
          chipsEl.innerHTML = chipItems.length
            ? chipItems.join('<span class="tm-sep" aria-hidden="true"></span>')
            : '<button class="tm-chip" type="button" aria-expanded="' + expanded + '" data-tm-trigger="1">' + barStar + '<span class="tm-val">' + escapeHtml(t('brand')) + '</span></button>';
          state.barLayoutKey = layoutKey;
        }

        chipsEl.querySelectorAll('[data-tm-trigger]').forEach(function(btn) {
          btn.setAttribute('aria-expanded', expanded);
        });
        var starSvg = chipsEl.querySelector('.tm-star');
        if (starSvg) starSvg.setAttribute('class', 'tm-star ' + starCls);

        var speedEl = chipsEl.querySelector('[data-tm-v="speed"]');
        if (speedEl) speedEl.textContent = tpsVal != null ? Number(tpsVal).toFixed(1) : '--';
        var cacheEl = chipsEl.querySelector('[data-tm-v="cache"]');
        if (cacheEl) cacheEl.textContent = fmtPct(cacheVal);
        var ctxEl = chipsEl.querySelector('[data-tm-v="ctx"]');
        if (ctxEl) ctxEl.textContent = fmtPct(ctxFrac);
        var qParts = getQuotaPairParts(quotaPair, leadQuota);
        var qWrap = chipsEl.querySelector('[data-tm-v="quota"]');
        if (qWrap) {
          var ql = qWrap.querySelector('[data-tm-q="l"]');
          var qr = qWrap.querySelector('[data-tm-q="r"]');
          var qSlash = qWrap.querySelector('.tm-slash');
          if (qParts.single !== undefined) {
            if (ql) ql.textContent = qParts.single;
            if (qSlash) qSlash.style.display = 'none';
            if (qr) qr.textContent = '';
          } else {
            if (ql) ql.textContent = qParts.left;
            if (qSlash) qSlash.style.display = '';
            if (qr) qr.textContent = qParts.right;
          }
        }
        var todayEl = chipsEl.querySelector('[data-tm-v="today"]');
        if (todayEl) todayEl.textContent = usage ? fmtTokens(usage.todayTokens) : '--';
        var monthEl = chipsEl.querySelector('[data-tm-v="month"]');
        if (monthEl) monthEl.textContent = usage ? fmtTokens(usage.monthTokens) : '--';
        syncContextRingEl(chipsEl.querySelector('[data-tm-ring="bar"]'), ctxFrac);
      }

      var pop = shadow.getElementById('tm-popover');
      if (pop) {
        pop.classList.toggle('open', state.popoverOpen);
        if (state.popoverOpen) {
          var qHtml = quotas.slice(0, 4).map(function(q) {
            if (q.fiveHour && q.weekly) {
              var worst = (q.fiveHour.pacing && q.fiveHour.pacing.status === 'burn') || (q.weekly.pacing && q.weekly.pacing.status === 'burn')
                ? 'burn'
                : (q.fiveHour.pacing && q.fiveHour.pacing.status === 'fast') || (q.weekly.pacing && q.weekly.pacing.status === 'fast')
                  ? 'fast' : 'ok';
              var paceLabel = worst === 'burn' ? t('paceBurn') : worst === 'fast' ? t('paceFast') : t('paceOk');
              var pairHtml = escapeHtml(fmtPctNum(q.fiveHour.remainingFraction)) + '<span class="tm-slash">/</span>' + escapeHtml(fmtPctNum(q.weekly.remainingFraction));
              return '<div class="tm-qitem"><div class="tm-qmeta"><span class="tm-qname" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) +
                '</span><span class="tm-qright"><span class="tm-pace-pill ' + worst + '">' + escapeHtml(paceLabel) + '</span><span class="tm-qpair" title="' + escapeHtml(t('quotaPairTip')) + '">' + pairHtml + '</span></span></div>' +
                renderQuotaSubBar(t('quotaTag5h'), q.fiveHour.remainingFraction, q.fiveHour.resetTime, q.fiveHour.pacing) +
                renderQuotaSubBar(t('quotaTagWeek'), q.weekly.remainingFraction, q.weekly.resetTime, q.weekly.pacing) +
              '</div>';
            }
            var kind = resolveQuotaKind(q);
            var tag = kind === '5h' ? t('quotaTag5h') : kind === 'week' ? t('quotaTagWeek') : '';
            return '<div class="tm-qitem"><div class="tm-qmeta"><span class="tm-qname" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) + '</span></div>' +
              renderQuotaSubBar(tag || '·', q.remainingFraction, q.resetTime, q.pacing) + '</div>';
          }).join('');

          var subtitle = (conv && conv.model) || (snap && snap.conversationUnavailable ? t('convUnavailable') : snap && snap.connected ? t('connected') : t('offline'));
          var heroNum = conv && conv.latestTps != null ? Number(conv.latestTps).toFixed(1) : (conv && conv.tps != null ? Number(conv.tps).toFixed(1) : '--');
          var styleNext = THEMES[(THEMES.indexOf(currentStyle()) + 1) % THEMES.length];
          var styleBtnText = currentStyle() === 'swiss' ? t('themeSwiss') : currentStyle() === 'glass' ? t('themeGlass') : t('themeMono');
          var isCopied = Date.now() < state.copiedUntil;
          var ctxFoot = '';
          if (conv && conv.context) {
            ctxFoot = buildContextRingSvg(ctxFrac, 'pop') + escapeHtml(fmtTokens(conv.context.usedTokens) + ' / ' + fmtTokens(conv.context.maxTokens)) +
              (conv.context.estimatedTurnsLeft ? ' · ' + escapeHtml(t('turnsLeft') + ' ' + conv.context.estimatedTurnsLeft + ' ' + t('turnsUnit')) : '');
          }

          pop.innerHTML =
            '<div class="tm-head">' +
              '<div class="tm-brand-row">' + buildSparkleIcon(starCls, true) +
                '<span class="tm-model" title="' + escapeHtml(subtitle) + '">' + escapeHtml(subtitle) + '</span>' +
                (isRunning ? '<span class="tm-status-tag">· ' + escapeHtml(t('generating')) + '</span>' : '') +
              '</div>' +
              '<div class="tm-head-acts">' +
                '<button class="tm-btn" type="button" id="tm-style-btn" title="' + escapeHtml(t('themeLabel')) + '">' + escapeHtml(styleBtnText) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-copy-btn">' + escapeHtml(isCopied ? t('copied') : t('copyStats')) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-lang-btn">' + (prefs.language === 'en' ? '中' : 'EN') + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="tm-hero">' +
              '<div class="tm-hero-main"><span class="tm-hero-num">' + escapeHtml(heroNum) + '</span><span class="tm-hero-unit">' + escapeHtml(t('speedUnit')) + '</span></div>' +
              '<div class="tm-hero-meta">' + escapeHtml(t('today')) + ' <b>' + escapeHtml(fmtTokens(usage && usage.todayTokens)) + '</b><br/>' + escapeHtml(t('month')) + ' <b>' + escapeHtml(fmtTokens(usage && usage.monthTokens)) + '</b></div>' +
            '</div>' +
            '<div class="tm-spark-wrap">' + buildSparklineSvg(conv && conv.sparkline) + '</div>' +
            '<div class="tm-sub-strip">' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('sessionSpeed')) + '</div><div class="tm-sub-v">' + (conv && conv.tps != null ? Number(conv.tps).toFixed(1) : '--') + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('ttft')) + '</div><div class="tm-sub-v">' + (conv && conv.ttftSeconds != null ? Number(conv.ttftSeconds).toFixed(2) + 's' : '--') + '</div></div>' +
              '<div class="tm-sub-cell"><div class="tm-sub-k">' + escapeHtml(t('cacheHit')) + '</div><div class="tm-sub-v">' + escapeHtml(fmtPct(cacheVal)) + '</div></div>' +
            '</div>' +
            buildTokenBreakdownHtml(conv) +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('usageOverview')) + '</span><span>' + safeInt(usage && usage.monthRequests) + ' ' + escapeHtml(t('requests')) + '</span></div>' +
              '<div class="tm-usage-strip">' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('today')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(usage && usage.todayTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('week')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(usage && usage.weekTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('month')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(usage && usage.monthTokens)) + '</div></div>' +
                '<div class="tm-usage-cell"><div class="tm-usage-k">' + escapeHtml(t('lifetime')) + '</div><div class="tm-usage-v">' + escapeHtml(fmtTokens(usage && usage.totalTokens)) + '</div></div>' +
              '</div></div>' +
            (qHtml ? '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('quotaTitle')) + '</span><span style="font-size:9.5px;">' + escapeHtml(t('paceLegend')) + '</span></div>' + qHtml + '</div>' : '') +
            '<div class="tm-foot">' +
              '<span class="tm-foot-ctx">' + ctxFoot + '</span>' +
              '<button class="tm-link" type="button" id="tm-open-modal">' + escapeHtml(t('openStats')) + '</button>' +
            '</div>';

          var styleBtn = shadow.getElementById('tm-style-btn');
          if (styleBtn) styleBtn.onclick = function(ev) {
            if (!ev || ev.isTrusted !== true) return;
            void updatePrefs({ theme: styleNext });
          };
          var copyBtn = shadow.getElementById('tm-copy-btn');
          if (copyBtn) copyBtn.onclick = function(ev) {
            if (!ev || ev.isTrusted !== true) return;
            if (copyTextSafe(buildCopySummaryText())) {
              state.copiedUntil = Date.now() + 1600;
              renderBar();
              setTimeout(function() { if (!state.disposed) renderBar(); }, 1650);
            }
          };
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
      modalHost.setAttribute('data-style', currentStyle());

      var usage = (state.snapshot && state.snapshot.usage) || { days: [], modelRank: [] };
      var dayMap = Object.create(null);
      (usage.days || []).forEach(function(d) {
        if (d && d.date) dayMap[d.date] = safeInt(d.total);
      });

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
        ['showMonth', t('optMonth')],
      ].map(function(pair) {
        var on = Boolean(state.prefs[pair[0]]);
        return '<label class="tm-pill ' + (on ? 'on' : '') + '"><input type="checkbox" data-pref-key="' + escapeHtml(pair[0]) + '"' + (on ? ' checked' : '') + '/><span class="tm-pill-dot"></span>' + escapeHtml(pair[1]) + '</label>';
      }).join('');

      var styleSeg = [
        ['swiss', t('themeSwiss')],
        ['glass', t('themeGlass')],
        ['mono', t('themeMono')],
      ].map(function(pair) {
        var active = currentStyle() === pair[0] ? ' active' : '';
        return '<button class="tm-seg-btn' + active + '" type="button" data-theme-pick="' + pair[0] + '">' + escapeHtml(pair[1]) + '</button>';
      }).join('');

      modalShadow.innerHTML =
        '<style>' + modalStyles() + '</style>' +
        '<div class="tm-backdrop" id="tm-backdrop" role="dialog" aria-modal="true">' +
          '<div class="tm-modal">' +
            '<div class="tm-mhead"><div class="tm-mtitle">' + buildSparkleIcon('idle', true) + escapeHtml(t('statsTitle')) + '</div>' +
              '<div class="tm-head-acts">' +
                '<button class="tm-btn" type="button" id="tm-modal-copy">' + escapeHtml(Date.now() < state.copiedUntil ? t('copied') : t('copyStats')) + '</button>' +
                '<button class="tm-btn" type="button" id="tm-close-modal">' + escapeHtml(t('close')) + '</button>' +
              '</div></div>' +
            '<div class="tm-summary">' +
              '<div class="tm-sum-cell"><div class="tm-sum-k">' + escapeHtml(t('today')) + '</div><div class="tm-sum-v">' + escapeHtml(fmtTokens(usage.todayTokens)) + '</div></div>' +
              '<div class="tm-sum-cell"><div class="tm-sum-k">' + escapeHtml(t('week')) + '</div><div class="tm-sum-v">' + escapeHtml(fmtTokens(usage.weekTokens)) + '</div></div>' +
              '<div class="tm-sum-cell"><div class="tm-sum-k">' + escapeHtml(t('month')) + '</div><div class="tm-sum-v">' + escapeHtml(fmtTokens(usage.monthTokens)) + '</div></div>' +
              '<div class="tm-sum-cell"><div class="tm-sum-k">' + escapeHtml(t('lifetime')) + '</div><div class="tm-sum-v">' + escapeHtml(fmtTokens(usage.totalTokens)) + '</div></div>' +
            '</div>' +
            '<div><div class="tm-sec-title"><span>' + escapeHtml(t('heatmapTitle')) + '</span></div><div class="tm-heat">' + colsHtml + '</div></div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('modelRankTitle')) + '</span></div>' +
              '<table class="tm-table"><thead><tr><th>' + escapeHtml(t('colModel')) + '</th><th>' + escapeHtml(t('colTotal')) + '</th><th>' + escapeHtml(t('colOutput')) + '</th><th>' + escapeHtml(t('colAvgTps')) + '</th><th>' + escapeHtml(t('colReq')) + '</th></tr></thead><tbody>' + rankRows + '</tbody></table></div>' +
            '<div class="tm-sec"><div class="tm-sec-title"><span>' + escapeHtml(t('customizeTitle')) + '</span><span>' + escapeHtml(t('themeLabel')) + '</span></div>' +
              '<div class="tm-pref-row"><div class="tm-toggles">' + toggles + '</div><div class="tm-seg">' + styleSeg + '</div></div></div>' +
          '</div>' +
        '</div>';

      modalShadow.getElementById('tm-close-modal').onclick = function() { state.modalOpen = false; renderModal(); };
      modalShadow.getElementById('tm-modal-copy').onclick = function(ev) {
        if (!ev || ev.isTrusted !== true) return;
        if (copyTextSafe(buildCopySummaryText())) {
          state.copiedUntil = Date.now() + 1600;
          renderModal();
          setTimeout(function() { if (!state.disposed && state.modalOpen) renderModal(); }, 1650);
        }
      };
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
      modalShadow.querySelectorAll('[data-theme-pick]').forEach(function(btn) {
        btn.onclick = function(ev) {
          if (!ev || ev.isTrusted !== true) return;
          void updatePrefs({ theme: btn.getAttribute('data-theme-pick') });
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
      ensureMounted();
      renderBar();
      if (state.modalOpen) renderModal();
    }

    function ensureMounted() {
      if (state.disposed) return;
      var anchor = findMountAnchor();
      if (!anchor || !anchor.parent) {
        if (hostEl && hostEl.isConnected) hostEl.remove();
        return;
      }

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

      var samePlacement = hostEl.getAttribute('data-placement') === anchor.placement;
      var alreadyPlaced =
        samePlacement &&
        hostEl.parentElement === anchor.parent &&
        (anchor.before ? hostEl.nextElementSibling === anchor.before : hostEl.nextElementSibling === null);
      if (alreadyPlaced) return;

      hostEl.setAttribute('data-placement', anchor.placement);
      if (anchor.before && anchor.before.parentElement === anchor.parent) {
        anchor.parent.insertBefore(hostEl, anchor.before);
      } else {
        anchor.parent.appendChild(hostEl);
      }
      renderBar();
    }

    async function refresh() {
      if (state.disposed || !window.__agTokenMeterApi) return;
      ensureMounted();
      var cid = detectConversationId();
      if (cid !== state.lastCid) {
        state.lastCid = cid;
        state.requestSeq++;
        if (state.snapshot) state.snapshot = Object.assign({}, state.snapshot, { conversation: null, conversationUnavailable: !cid });
        renderBar();
      }
      if (!cid) return;
      var mySeq = ++state.requestSeq;
      try {
        var snap = await window.__agTokenMeterApi.getSnapshot(cid);
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
      ensureMounted();
      if (state.popoverOpen) positionPopover();
    }

    function dispose() {
      state.disposed = true;
      state.barLayoutKey = '';
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
