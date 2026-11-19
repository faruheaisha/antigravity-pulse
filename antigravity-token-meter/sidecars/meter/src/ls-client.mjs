/**
 * Antigravity 本机 language_server ConnectRPC 零代理直连客户端。
 *
 * 严格安全边界：
 * 1. 仅使用宿主注入的显式回环端点（ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN），
 *    彻底移除任何系统进程扫描或凭据抓取逻辑；
 * 2. 仅允许连接本地回环地址（127.0.0.1 / ::1 / localhost），agent: false 绕过应用层代理；
 * 3. 单次请求与整条重试链共享硬截止时间，防止慢连接阻塞轮询。
 */
import http from 'node:http';
import https from 'node:https';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_RPC_BYTES = 16 * 1024 * 1024;

export function parseLoopbackEndpoint(rawAddr) {
  if (!rawAddr || typeof rawAddr !== 'string') return null;
  const trimmed = rawAddr.trim();
  const hasScheme = trimmed.includes('://');
  const normalized = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(normalized);
    if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname)) return null;
    if (u.username || u.password) return null;
    if (u.pathname && u.pathname !== '/') return null;
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const rawHost = u.hostname.replace(/^\[|\]$/g, '');
    return {
      protocol: hasScheme ? u.protocol : null,
      hostname: rawHost === 'localhost' ? '127.0.0.1' : rawHost,
      port,
    };
  } catch {
    return null;
  }
}

export function postLoopbackRpc({
  protocol,
  hostname = '127.0.0.1',
  port,
  csrfToken,
  method,
  body = {},
  timeoutMs = 4500,
}) {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(cleanHost)) {
    return Promise.reject(new Error('non_loopback_forbidden'));
  }
  if (!['http:', 'https:'].includes(protocol)) {
    return Promise.reject(new Error('invalid_protocol'));
  }
  const boundedTimeout = Math.max(200, Math.min(10000, Number(timeoutMs) || 4500));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        hostname: cleanHost,
        port,
        family: cleanHost.includes(':') ? 6 : 4,
        path: `${SERVICE_PREFIX}${method}`,
        method: 'POST',
        agent: false,
        ...(protocol === 'https:' ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken,
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          req.destroy();
          const err = new Error(`rpc_http_${res.statusCode || 0}`);
          err.statusCode = res.statusCode;
          finish(err);
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RPC_BYTES) {
            req.destroy();
            finish(new Error('rpc_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(new Error('rpc_aborted')));
        res.on('error', (err) => finish(err));
        res.on('end', () => {
          const text = Buffer.concat(chunks, total).toString('utf8');
          try {
            const parsed = text ? JSON.parse(text) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              finish(new Error('rpc_invalid_json'));
              return;
            }
            finish(null, parsed);
          } catch {
            finish(new Error('rpc_invalid_json'));
          }
        });
      }
    );

    const hardTimer = setTimeout(() => {
      req.destroy();
      finish(new Error(`rpc_timeout_${method}`));
    }, boundedTimeout);
    hardTimer.unref?.();

    req.on('error', (err) => finish(err));
    req.write(payload);
    req.end();
  });
}

export class LanguageServerClient {
  /**
   * @param {{ env?: Record<string, string | undefined>, rpcImpl?: typeof postLoopbackRpc }} [opts]
   */
  constructor({ env = process.env, rpcImpl = postLoopbackRpc } = {}) {
    this.env = env;
    this.rpcImpl = rpcImpl;
    this._resolved = null;
    this._generation = 0;
    this._resolving = null;
  }

  get currentEndpoint() {
    return this._resolved ? { ...this._resolved } : null;
  }

  async resolveEndpoint(force = false, deadlineMs = Date.now() + 4000) {
    if (this._resolved && !force) return this._resolved;
    if (this._resolving) return this._resolving;

    this._resolving = (async () => {
      const envAddr = parseLoopbackEndpoint(this.env.ANTIGRAVITY_LS_ADDRESS);
      const envCsrf = this.env.ANTIGRAVITY_CSRF_TOKEN;
      if (!envAddr || !envCsrf) return null;

      const protocols = envAddr.protocol ? [envAddr.protocol] : ['https:', 'http:'];
      for (const protocol of protocols) {
        const remaining = deadlineMs - Date.now();
        if (remaining < 300) break;
        try {
          await this.rpcImpl({
            protocol,
            hostname: envAddr.hostname,
            port: envAddr.port,
            csrfToken: envCsrf,
            method: 'GetUserStatus',
            body: { metadata: { ideName: 'antigravity' } },
            timeoutMs: Math.min(2500, remaining),
          });
          this._generation++;
          this._resolved = {
            protocol,
            hostname: envAddr.hostname,
            port: envAddr.port,
            csrfToken: envCsrf,
            generation: this._generation,
          };
          return this._resolved;
        } catch {}
      }
      return null;
    })().finally(() => {
      this._resolving = null;
    });

    return this._resolving;
  }

  async call(method, body = {}, totalBudgetMs = 5000) {
    const deadline = Date.now() + totalBudgetMs;
    let ep = await this.resolveEndpoint(false, deadline);
    if (!ep) throw new Error('ls_unavailable');

    const rem1 = deadline - Date.now();
    if (rem1 < 250) throw new Error('rpc_budget_exhausted');
    try {
      return await this.rpcImpl({ ...ep, method, body, timeoutMs: rem1 });
    } catch (err) {
      if (this._resolved && this._resolved.generation === ep.generation) {
        this._resolved = null;
      }
      const rem2 = deadline - Date.now();
      if (rem2 < 400) throw err;
      ep = await this.resolveEndpoint(false, deadline);
      if (!ep) throw err;
      return await this.rpcImpl({ ...ep, method, body, timeoutMs: Math.max(250, deadline - Date.now()) });
    }
  }

  getUserStatus() {
    return this.call('GetUserStatus', { metadata: { ideName: 'antigravity' } });
  }

  retrieveUserQuotaSummary(forceRefresh = false) {
    return this.call('RetrieveUserQuotaSummary', { request: {}, forceRefresh: Boolean(forceRefresh) });
  }

  getAllTrajectories() {
    return this.call('GetAllCascadeTrajectories', {});
  }

  getGeneratorMetadata(cascadeId) {
    return this.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId });
  }
}
