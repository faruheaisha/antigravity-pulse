import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CdpInlineBridge, discoverHubTargets, isTrustedHubTarget, validateBridgePayload } from '../src/cdp-bridge.mjs';

function mockTarget(id = 'p1', cdpPort = 54321, hubPort = 53150) {
  return {
    type: 'page',
    url: `https://127.0.0.1:${hubPort}/c/11111111-1111-1111-1111-111111111111`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/${id}`,
  };
}

class FakeCdpSession {
  constructor(opts) {
    this.opts = opts;
    this.calls = [];
    this.closed = false;
    this.worldId = 42;
  }
  async open() { return this; }
  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ++this.worldId };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
    if (method === 'Runtime.evaluate' && params.returnByValue) {
      return { result: { value: { mounted: true, installed: true, bridge: true } } };
    }
    return {};
  }
  close() { this.closed = true; }
}

test('isTrustedHubTarget 校验预期 Hub 端口，拒绝其他本地服务、远程页面与 iframe', () => {
  assert.equal(isTrustedHubTarget(mockTarget('a', 54321, 53150), 54321, 53150), true);
  assert.equal(isTrustedHubTarget(mockTarget('a', 54321, 8080), 54321, 53150), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget(), url: 'https://github.com/a/b' }, 54321, null), false);
  assert.equal(isTrustedHubTarget({ ...mockTarget(), type: 'iframe' }, 54321, null), false);
});

test('validateBridgePayload 仅允许白名单消息类型并严格验证 UUID', () => {
  assert.ok(validateBridgePayload(JSON.stringify({ id: 1, type: 'snapshot', input: { conversationId: null } })));
  assert.equal(validateBridgePayload(JSON.stringify({ id: 1, type: 'snapshot', input: { conversationId: 'bad-id' } })), null);
  assert.equal(validateBridgePayload(JSON.stringify({ id: 1, type: 'diag', input: { mounted: true } })), null);
});

test('discoverHubTargets 遇到过期端口文件不会锁死，返回 stale_port 诊断码', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-cdp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/fake\n', 'utf8');
  await assert.rejects(() => discoverHubTargets([dir]), (err) => err.diagCode === 'stale_port');
});

test('CdpInlineBridge 使用 Isolated World 隔离，导航切换文档代次后丢弃旧慢请求回包', async () => {
  const sessions = [];
  let resolveSlow;
  const bridge = new CdpInlineBridge({
    profileCandidates: ['/none'],
    widgetCode: 'window.__agTokenMeterMounted=true;',
    getExpectedHubPort: () => 53150,
    getSnapshot: () => new Promise((r) => { resolveSlow = r; }),
    getPrefs: async () => ({ language: 'zh-CN' }),
    setPrefs: async (p) => p,
    discover: async () => ({ port: 54321, targets: [mockTarget()] }),
    createSession: (_url, opts) => {
      const s = new FakeCdpSession(opts);
      sessions.push(s);
      return s;
    },
  });

  await bridge.tick();
  assert.equal(bridge.status.state, 'mounted');
  const s = sessions[0];
  // 确认 Runtime.addBinding 指定了 executionContextName（Isolated World）
  const addBindingCall = s.calls.find((c) => c.method === 'Runtime.addBinding');
  assert.equal(addBindingCall.params.executionContextName, 'AntigravityTokenMeterWorld');

  // 发起一个慢请求，但在返回前页面发生顶层导航（docEpoch 递增）
  const ctxId = s.worldId;
  const evalBefore = s.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  const reqPromise = bridge._handleEvent(s, {
    method: 'Runtime.bindingCalled',
    params: { name: bridge.bindingName, executionContextId: ctxId, payload: JSON.stringify({ id: 1, type: 'snapshot', input: {} }) },
  });
  await new Promise((r) => setImmediate(r));
  await bridge._handleEvent(s, { method: 'Page.frameNavigated', params: { frame: { id: 'main-frame' } } });
  resolveSlow({ connected: true });
  await reqPromise;

  // 因为文档代次已变，旧回包必须被丢弃，不得向新文档投递
  const evalAfter = s.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  assert.equal(evalAfter, evalBefore);

  await bridge.stop();
  assert.equal(s.closed, true);
});
