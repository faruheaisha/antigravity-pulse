import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationSeconds,
  parseTokenCount,
  projectUserStatus,
  computeConversationTelemetry,
} from '../src/telemetry.mjs';

test('parseDurationSeconds 与 parseTokenCount 严格拒绝布尔、数组、空白与越界值', () => {
  assert.equal(parseDurationSeconds('6.25s'), 6.25);
  assert.equal(parseDurationSeconds({ seconds: 2, nanos: 500000000 }), 2.5);
  assert.equal(parseDurationSeconds({ seconds: 1, nanos: 2_000_000_000 }), null);
  assert.equal(parseTokenCount('123'), 123);
  assert.equal(parseTokenCount(true), null);
  assert.equal(parseTokenCount('   '), null);
  assert.equal(parseTokenCount([]), null);
  assert.equal(parseTokenCount(Infinity), null);
});

test('projectUserStatus 立即剔除邮箱等敏感字段；computeConversationTelemetry 先去重再汇总且不泄露原始 ID', () => {
  const proj = projectUserStatus({
    email: 'secret@example.com',
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_M532' }, quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-19T12:00:00Z' } },
      ],
    },
  });
  assert.equal(JSON.stringify(proj.quotas).includes('secret@example.com'), false);

  const result = computeConversationTelemetry({
    cascadeId: '11111111-1111-1111-1111-111111111111',
    status: 'CASCADE_RUN_STATUS_RUNNING',
    modelLabelMap: proj.labelMap,
    generatorMetadata: [
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_M532',
          systemPrompt: 'SENSITIVE_PROMPT_MUST_NOT_LEAK',
          timeToFirstToken: '2.5s',
          streamingDuration: '10.0s',
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 50000, maxContextTokens: 500000 } },
          usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1500', thinkingOutputTokens: '1000', responseOutputTokens: '500', responseId: 'raw-secret-resp-1' },
        },
      },
      // 同 responseId 重复出现时只计一次（最终快照覆盖），UI 与账本口径一致
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_M532',
          timeToFirstToken: '2.5s',
          streamingDuration: '10.0s',
          usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1500', thinkingOutputTokens: '1000', responseOutputTokens: '500', responseId: 'raw-secret-resp-1' },
        },
      },
      {
        stepIndices: [3],
        chatModel: {
          model: 'MODEL_M532',
          timeToFirstToken: '1.0s',
          streamingDuration: '0.01s',
          usage: { inputTokens: '200', cacheReadTokens: '800', outputTokens: '100', responseId: 'raw-resp-glitch' },
        },
      },
    ],
  });

  assert.equal(result.model, 'Gemini 4 Neon (High)');
  assert.equal(result.tps, 150);
  assert.equal(result.latestTps, 150);
  assert.equal(result.excludedOutliers, 1);
  assert.equal(result.requests, 2);
  assert.equal(result.tokens.output, 1600);
  assert.equal(JSON.stringify(result).includes('SENSITIVE_PROMPT'), false);
  // 账本去重 ID 已单向哈希，不含原始 responseId
  assert.equal(result.ledgerEvents.some((e) => e.id.includes('raw-secret-resp-1')), false);
});
