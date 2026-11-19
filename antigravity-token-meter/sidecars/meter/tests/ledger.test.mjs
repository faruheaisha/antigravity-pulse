import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../src/ledger.mjs';

test('UsageLedger 并发 ingest 不丢写、支持差值 upsert、防 __proto__ 原型污染并保留损坏文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');
  const nowIso = new Date().toISOString();

  const ledger = new UsageLedger(file);
  // 并发写入 + 增量更新同一事件 ID + 恶意 __proto__ 模型名
  await Promise.all([
    ledger.ingest([{ id: 'e1', timestamp: nowIso, model: 'Gemini 4 Neon', inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 200, streamingSeconds: 2, timedOutputTokens: 200 }]),
    ledger.ingest([{ id: 'e2', timestamp: nowIso, model: '__proto__', inputTokens: 100, cacheReadTokens: 0, outputTokens: 50, streamingSeconds: 1, timedOutputTokens: 50 }]),
  ]);
  // 同一请求 e1 后续完成输出增长到 600 tokens，应按差值 +400 补记而非忽略或双倍计算
  await ledger.ingest([{ id: 'e1', timestamp: nowIso, model: 'Gemini 4 Neon', inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 600, streamingSeconds: 4, timedOutputTokens: 600 }]);
  await ledger.flush();

  // 确认未污染 Object.prototype
  assert.equal(({}).total, undefined);

  const reloaded = new UsageLedger(file);
  const snap = await reloaded.snapshot(new Date(nowIso));
  assert.equal(snap.todayTokens, 3750);
  assert.equal(snap.totalTokens, 3750);
  assert.equal(snap.todayRequests, 2);
  const neon = snap.modelRank.find((m) => m.model === 'Gemini 4 Neon');
  assert.equal(neon.avgTps, 150);

  // 损坏账本保留原文件不静默覆盖
  const brokenFile = join(dir, 'broken.json');
  await writeFile(brokenFile, '{corrupted-json', 'utf8');
  const brokenLedger = new UsageLedger(brokenFile);
  await brokenLedger.ingest([{ id: 'x1', timestamp: nowIso, model: 'M', inputTokens: 10, cacheReadTokens: 0, outputTokens: 5 }]);
  assert.equal(brokenLedger.corrupted, true);
  assert.equal(await readFile(brokenFile, 'utf8'), '{corrupted-json');
});
