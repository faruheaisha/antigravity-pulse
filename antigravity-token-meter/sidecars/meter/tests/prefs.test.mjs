import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferencesStore, sanitizePrefsPatch } from '../src/prefs.mjs';

test('PreferencesStore 白名单校验、并行更新串行化不丢字段且版本号单调递增', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.throws(() => sanitizePrefsPatch({ language: 'fr' }));
  assert.throws(() => sanitizePrefsPatch({ unknownKey: true }));
  assert.throws(() => sanitizePrefsPatch({ showSpeed: 'yes' }));

  const store = new PreferencesStore(join(dir, 'preferences.json'));
  const [r1, r2] = await Promise.all([
    store.update({ language: 'en' }),
    store.update({ showToday: true }),
  ]);
  assert.equal(r1.version, 1);
  assert.equal(r2.version, 2);

  const reloaded = new PreferencesStore(join(dir, 'preferences.json'));
  const saved = await reloaded.get();
  assert.equal(saved.language, 'en');
  assert.equal(saved.showToday, true);
  assert.equal(saved.version, 2);
});
