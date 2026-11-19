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
  assert.equal(snap.todayInput, 1100);
  assert.equal(snap.todayCacheRead, 2000);
  assert.equal(snap.todayOutput, 650);
  assert.equal(snap.todayByModel[0].model, 'Gemini 4 Neon');
  assert.equal(snap.todayByModel[0].totalTokens, 3600);
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

test('UsageLedger 支持聚合历史导入、重叠替换、幂等防重与 pending-import.json 自动吸纳', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ledger-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger-v1.json');

  // 预先模拟用户当天试跑记入了一笔重叠数据，以及次日一笔全新数据
  const seed = new UsageLedger(file);
  await seed.ingest([
    { id: 'overlap-1', timestamp: '2026-11-19T14:40:00.000Z', model: 'Gemini 4 Neon', inputTokens: 500, cacheReadTokens: 500, outputTokens: 100 },
    { id: 'future-1', timestamp: '2026-11-20T01:00:00.000Z', model: 'Gemini 4 Neon', inputTokens: 200, cacheReadTokens: 300, outputTokens: 50 },
  ]);

  // 写入 pending-import.json 模拟 sidecar 运行中落盘保护队列
  const bundle = {
    schema: 1,
    batchId: 'legacy-usage-v1-testbatch',
    source: 'legacy-usage-v1',
    importedUntil: '2026-11-19T14:33:04.257Z',
    replaceOverlappingBeforeCutoff: true,
    lifetimeTotal: 150000,
    days: {
      '2026-10-15': { total: 50000, input: 10000, cacheRead: 35000, output: 5000, requests: 12, byModel: { 'Gemini 4 Argon': 50000 } },
      '2026-11-19': { total: 100000, input: 20000, cacheRead: 70000, output: 10000, requests: 30, byModel: { 'Gemini 4 Argon': 100000 } },
    },
    models: {
      'Gemini 4 Argon': { total: 150000, input: 30000, cacheRead: 105000, output: 15000, thinking: 3000, requests: 42, timedOutput: 0, streamingSec: 0 },
    },
  };
  await writeFile(join(dir, 'pending-import.json'), JSON.stringify(bundle), 'utf8');

  // readOnly 模式不得消费 pending-import.json
  const roLedger = new UsageLedger(file, { readOnly: true });
  const roSnap = await roLedger.snapshot(new Date('2026-11-20T02:00:00.000Z'));
  assert.equal(roSnap.totalTokens, 1650);

  // 正常读写实例启动 load 自动吸纳 pending-import.json 并原子归档
  const live = new UsageLedger(file);
  const snap = await live.snapshot(new Date('2026-11-20T02:00:00.000Z'));
  // 2026-11-19 试跑重叠 1100 被干净替换为旧账本 100000，2026-11-20 新数据 550 完整保留 -> 累计 150550
  assert.equal(snap.totalTokens, 150550);
  assert.equal(snap.monthTokens, 100550);
  assert.equal(snap.monthRequests, 31);
  assert.equal(snap.activeDays, 3);
  assert.equal(snap.peakDay.date, '2026-11-19');
  assert.equal(snap.peakDay.total, 100000);
  assert.equal(snap.currentStreak, 2);
  assert.equal(snap.longestStreak, 2);
  assert.equal(snap.days[snap.days.length - 2].byModel['Gemini 4 Argon'], 100000);
  assert.equal(snap.importedUntil, '2026-11-19T14:33:04.257Z');
  assert.equal(await live.getImportedUntilMs(), Date.parse('2026-11-19T14:33:04.257Z'));

  // 重复应用同一 batchId 必须幂等跳过
  const dup = await live.applyImportBundle(bundle);
  assert.equal(dup.applied, false);
  assert.equal(dup.reason, 'already_applied');
});
