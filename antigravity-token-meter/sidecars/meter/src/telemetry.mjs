/**
 * Token 速率、缓存命中率、上下文窗口与模型额度计算引擎（严格输入校验版）。
 *
 * 数据边界：
 * - 内存读取：仅读取宿主 RPC 返回的数值统计、模型名称与配额比例；
 * - 绝不读取、缓存或向外透传任何 systemPrompt、对话正文、用户邮箱或令牌；
 * - 账本去重键采用局部 SHA-256 不可逆哈希，不落盘原始会话 ID 或消息 ID。
 */
import { createHash } from 'node:crypto';

const MAX_METADATA_ITEMS = 5000;
const INT_STR_RE = /^\d{1,15}$/;
const DUR_STR_RE = /^(\d{1,9}(?:\.\d{1,9})?)s$/i;

/**
 * 严格解析 Protobuf Duration（字符串 "6.25s" 或 { seconds, nanos } 对象）。
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseDurationSeconds(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 86400 ? value : null;
  }
  if (typeof value === 'string') {
    const m = value.trim().match(DUR_STR_RE);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 0 && n <= 86400 ? n : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sec = value.seconds === undefined ? 0 : Number(value.seconds);
    const nanos = value.nanos === undefined ? 0 : Number(value.nanos);
    if (
      Number.isInteger(sec) && sec >= 0 && sec <= 86400 &&
      Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9
    ) {
      return sec + nanos / 1e9;
    }
  }
  return null;
}

/**
 * 严格解析非负安全整数 Token 计数（拒绝布尔、数组、空白文本、Infinity）。
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseTokenCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!INT_STR_RE.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * 将 GetUserStatus 立即投影为最小脱敏 DTO（不保留邮箱、头像、账单等原始字段）。
 * @param {any} userStatus
 */
export function projectUserStatus(userStatus) {
  const labelMap = new Map();
  const rawQuotas = [];
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (Array.isArray(configs)) {
    for (const cfg of configs.slice(0, 200)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const id = cfg.modelOrAlias?.model || cfg.modelOrAlias?.alias;
      const label = typeof cfg.label === 'string' ? cfg.label.trim().slice(0, 120) : '';
      if (id && label) labelMap.set(String(id).slice(0, 120), label);

      const q = cfg.quotaInfo;
      if (q && typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction)) {
        const frac = Math.max(0, Math.min(1, q.remainingFraction));
        const resetTime = typeof q.resetTime === 'string' && Number.isFinite(Date.parse(q.resetTime)) ? q.resetTime : null;
        rawQuotas.push({ label: label || 'Model', remainingFraction: frac, resetTime });
      }
    }
  }

  // 将具有相同 resetTime 与相同剩余比例（精确到千分位）的模型聚合展示，标注为展示分组
  const grouped = new Map();
  for (const item of rawQuotas) {
    const key = `${item.resetTime || 'none'}|${Math.round(item.remainingFraction * 1000)}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        remainingFraction: item.remainingFraction,
        resetTime: item.resetTime,
        models: [],
      });
    }
    const g = grouped.get(key);
    if (!g.models.includes(item.label)) g.models.push(item.label);
  }

  const quotas = [...grouped.values()]
    .map((g) => {
      const lead = g.models[0] || 'Model';
      const title = g.models.length > 1 ? `${lead.replace(/\s*\([^)]*\)$/, '')} (+${g.models.length - 1})` : lead;
      return {
        title,
        leadModel: lead,
        modelCount: g.models.length,
        models: g.models.slice(0, 12),
        remainingFraction: g.remainingFraction,
        resetTime: g.resetTime,
      };
    })
    .sort((a, b) => a.remainingFraction - b.remainingFraction);

  return { labelMap, quotas };
}

/**
 * 兼容导出：构建 modelId -> 人类可读名称映射。
 */
export function buildModelLabelMap(userStatus) {
  return projectUserStatus(userStatus).labelMap;
}

/**
 * 兼容导出：提取聚合配额列表。
 */
export function extractQuotaGroups(userStatus) {
  return projectUserStatus(userStatus).quotas;
}

export function resolveModelName(rawId, labelMap) {
  if (!rawId || typeof rawId !== 'string') return 'Unknown';
  const key = rawId.trim().slice(0, 120);
  if (!key) return 'Unknown';
  return labelMap?.get(key) || key;
}

/**
 * 过滤极端短窗口缓冲毛刺，防止 10ms 尾包把速率拉爆至数万 tok/s。
 */
export function isReliableSpeedSample(sample) {
  if (!sample.streamingSeconds || sample.streamingSeconds <= 0) return false;
  if (!sample.outputTokens || sample.outputTokens <= 0) return false;
  const rawTps = sample.outputTokens / sample.streamingSeconds;
  if (!Number.isFinite(rawTps) || rawTps <= 0) return false;
  if (sample.streamingSeconds < 0.05 && rawTps > 2500) return false;
  if (
    sample.streamingSeconds < 0.4 &&
    sample.ttftSeconds !== null &&
    sample.ttftSeconds >= 2 &&
    rawTps > 1200
  ) {
    return false;
  }
  return true;
}

function hashEventKey(namespace, rawKey) {
  return createHash('sha256').update(`${namespace}\0${rawKey}`).digest('hex').slice(0, 24);
}

/**
 * 先归一化并按请求键去重，再统一计算会话指标与账本 upsert 事件，保证 UI 与账本 100% 口径一致。
 */
export function computeConversationTelemetry({
  cascadeId,
  status = '',
  generatorMetadata = [],
  modelLabelMap = new Map(),
  fallbackDate = new Date().toISOString(),
}) {
  const list = Array.isArray(generatorMetadata)
    ? generatorMetadata.slice(0, MAX_METADATA_ITEMS)
    : [];

  let latestContext = null;
  const deduped = new Map();

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const cm = entry?.chatModel;
    if (!cm || typeof cm !== 'object' || Array.isArray(cm)) continue;

    const ctxMeta = cm.chatStartMetadata?.contextWindowMetadata;
    if (ctxMeta && typeof ctxMeta === 'object') {
      const used = parseTokenCount(ctxMeta.estimatedTokensUsed);
      const max = parseTokenCount(ctxMeta.maxContextTokens);
      if (used !== null && max !== null && max > 0) {
        latestContext = {
          usedTokens: used,
          maxTokens: max,
          remainingTokens: Math.max(0, max - used),
          usedFraction: Math.min(1, used / max),
        };
      }
    }

    const usage = cm.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;

    const uncachedInput = parseTokenCount(usage.inputTokens) ?? 0;
    const cacheRead = parseTokenCount(usage.cacheReadTokens) ?? 0;
    const cacheWrite = parseTokenCount(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens) ?? 0;
    const responseOut = parseTokenCount(usage.responseOutputTokens);
    const thinkingOut = parseTokenCount(usage.thinkingOutputTokens);
    const rawOut = parseTokenCount(usage.outputTokens);

    const effectiveOutput =
      rawOut !== null
        ? rawOut
        : responseOut !== null || thinkingOut !== null
          ? (responseOut ?? 0) + (thinkingOut ?? 0)
          : 0;
    const effectiveResponse =
      responseOut !== null
        ? responseOut
        : thinkingOut !== null
          ? Math.max(0, effectiveOutput - thinkingOut)
          : effectiveOutput;
    const effectiveThinking = thinkingOut ?? 0;

    if (uncachedInput + cacheRead + cacheWrite + effectiveOutput <= 0) continue;

    const modelName = resolveModelName(
      cm.modelDisplayName || cm.responseModel || cm.model || usage.model || '',
      modelLabelMap
    );
    const streamingSec = parseDurationSeconds(cm.streamingDuration);
    const ttftSec = parseDurationSeconds(cm.timeToFirstToken);

    const stepTag = Array.isArray(entry.stepIndices) && entry.stepIndices.length > 0
      ? `step:${entry.stepIndices.join(',')}`
      : `idx:${i}`;
    const rawStableId =
      (typeof usage.responseId === 'string' && usage.responseId.trim()) ||
      (typeof usage.messageId === 'string' && usage.messageId.trim()) ||
      stepTag;

    const hashedKey = hashEventKey(String(cascadeId || 'default'), rawStableId);
    const ts = typeof cm.requestTime === 'string' && Number.isFinite(Date.parse(cm.requestTime))
      ? cm.requestTime
      : fallbackDate;

    // 同一请求后续出现更完整的最终快照时覆盖旧中间态
    deduped.set(hashedKey, {
      id: hashedKey,
      timestamp: ts,
      model: modelName,
      inputTokens: uncachedInput,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: effectiveOutput,
      responseOutputTokens: effectiveResponse,
      thinkingTokens: effectiveThinking,
      streamingSeconds: streamingSec,
      ttftSeconds: ttftSec,
    });
  }

  let totalUncachedInput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let totalResponseOutput = 0;
  let totalThinkingOutput = 0;
  let weightedOutput = 0;
  let weightedStreamingSec = 0;
  let measuredRequests = 0;
  let excludedOutliers = 0;

  let latestSample = null;
  let latestModel = null;
  const sparkline = [];
  const ledgerEvents = [];

  for (const item of deduped.values()) {
    totalUncachedInput += item.inputTokens;
    totalCacheRead += item.cacheReadTokens;
    totalCacheWrite += item.cacheWriteTokens;
    totalOutput += item.outputTokens;
    totalResponseOutput += item.responseOutputTokens;
    totalThinkingOutput += item.thinkingTokens;
    latestModel = item.model;

    let reliableTps = null;
    if (item.streamingSeconds !== null && item.streamingSeconds > 0 && item.outputTokens > 0) {
      if (isReliableSpeedSample(item)) {
        reliableTps = item.outputTokens / item.streamingSeconds;
        weightedOutput += item.outputTokens;
        weightedStreamingSec += item.streamingSeconds;
        measuredRequests++;
        latestSample = {
          tps: Number(reliableTps.toFixed(1)),
          ttft: item.ttftSeconds !== null ? Number(item.ttftSeconds.toFixed(2)) : null,
          model: item.model,
        };
        sparkline.push({
          tps: latestSample.tps,
          ttft: latestSample.ttft,
          tokens: item.outputTokens,
          model: item.model,
        });
      } else {
        excludedOutliers++;
      }
    }

    ledgerEvents.push({
      id: item.id,
      timestamp: item.timestamp,
      model: item.model,
      inputTokens: item.inputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens,
      outputTokens: item.outputTokens,
      thinkingTokens: item.thinkingTokens,
      streamingSeconds: reliableTps !== null ? item.streamingSeconds : 0,
      timedOutputTokens: reliableTps !== null ? item.outputTokens : 0,
    });
  }

  const totalInputAll = totalUncachedInput + totalCacheRead + totalCacheWrite;
  const totalTokens = totalInputAll + totalOutput;
  const cacheHitRate = totalInputAll > 0 ? totalCacheRead / totalInputAll : null;
  const sessionTps = weightedStreamingSec > 0 ? weightedOutput / weightedStreamingSec : null;

  return {
    cascadeId,
    status: String(status || ''),
    running: status === 'CASCADE_RUN_STATUS_RUNNING',
    model: latestSample?.model || latestModel,
    requests: ledgerEvents.length,
    measuredRequests,
    excludedOutliers,
    tps: sessionTps !== null ? Number(sessionTps.toFixed(1)) : null,
    latestTps: latestSample ? latestSample.tps : null,
    ttftSeconds: latestSample ? latestSample.ttft : null,
    streamingSeconds: Number(weightedStreamingSec.toFixed(2)),
    cacheHitRate: cacheHitRate !== null ? Number(cacheHitRate.toFixed(4)) : null,
    tokens: {
      total: totalTokens,
      inputAll: totalInputAll,
      uncachedInput: totalUncachedInput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      output: totalOutput,
      responseOutput: totalResponseOutput,
      thinkingOutput: totalThinkingOutput,
    },
    context: latestContext,
    sparkline: sparkline.slice(-16),
    ledgerEvents,
  };
}
