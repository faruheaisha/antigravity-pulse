/**
 * 严格遵循 RFC 6455 的零依赖本地回环 WebSocket 客户端（仅连 127.0.0.1 / ::1）。
 *
 * 通过 node:net 直接建立本地回环 TCP 连接，绕过应用层 HTTP_PROXY / HTTPS_PROXY /
 * NODE_USE_ENV_PROXY 代理环境变量。严格校验握手头、帧掩码、RSV 位、控制帧长度、
 * 分片状态机、消息与分片预算以及严格 UTF-8 编码。
 */
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_FRAGMENTS = 256;
const MAX_OUTBOUND_BYTES = 1 * 1024 * 1024;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * 将客户端出站帧编码为带 4 字节随机掩码的标准 RFC 6455 帧。
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;

  const mask = randomBytes(4);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);

  let offset = 2;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  mask.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < len; i++) {
    frame[offset + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

/**
 * 严格解析 WebSocket 握手响应头并验证 RFC 6455 Section 4.1 要求。
 */
export function validateHandshakeResponse(rawHeader, expectedAccept) {
  const lines = rawHeader.split('\r\n');
  const statusLine = lines[0] || '';
  if (!/^HTTP\/1\.1 101(?:\s|$)/.test(statusLine)) {
    throw new Error(`WebSocket 握手状态无效: ${statusLine}`);
  }
  const headers = new Map();
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx <= 0) continue;
    const name = lines[i].slice(0, idx).trim().toLowerCase();
    const val = lines[i].slice(idx + 1).trim();
    if (!headers.has(name)) headers.set(name, []);
    headers.get(name).push(val);
  }

  const upgrade = (headers.get('upgrade') || []).join(', ').toLowerCase();
  if (!upgrade.split(',').map((s) => s.trim()).includes('websocket')) {
    throw new Error('缺少合法 Upgrade: websocket 响应头');
  }
  const connection = (headers.get('connection') || []).join(', ').toLowerCase();
  if (!connection.split(',').map((s) => s.trim()).includes('upgrade')) {
    throw new Error('缺少合法 Connection: Upgrade 响应头');
  }
  const accepts = headers.get('sec-websocket-accept') || [];
  if (accepts.length !== 1 || accepts[0] !== expectedAccept) {
    throw new Error('Sec-WebSocket-Accept 校验失败');
  }
  if ((headers.get('sec-websocket-extensions') || []).some((v) => v.length > 0)) {
    throw new Error('拒收未协商的 WebSocket 扩展');
  }
  if ((headers.get('sec-websocket-protocol') || []).some((v) => v.length > 0)) {
    throw new Error('拒收未协商的 WebSocket 子协议');
  }
}

export class LoopbackWebSocket extends EventEmitter {
  /**
   * @param {string} wsUrl
   * @param {{ connectTimeoutMs?: number }} [options]
   */
  constructor(wsUrl, { connectTimeoutMs = 4000 } = {}) {
    super();
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error('LoopbackWebSocket 仅允许连接本地回环 ws:// 地址');
    }
    if (parsed.username || parsed.password) {
      throw new Error('不允许携带 URL 用户凭据');
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('无效的 WebSocket 端口');
    }

    const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
    this.host = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
    this.isIpv6 = this.host.includes(':');
    this.port = port;
    this.hostHeader = this.isIpv6 ? `[${this.host}]:${port}` : `${this.host}:${port}`;
    this.path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    this.connectTimeoutMs = connectTimeoutMs;

    this.socket = null;
    this.readyState = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    this._connectStarted = false;
    this._handshakeDone = false;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._fragOpcode = 0;
    this._fragParts = [];
    this._fragBytes = 0;
  }

  _consume(n) {
    if (n === 0) return Buffer.alloc(0);
    if (this._chunks.length === 1 && this._chunks[0].length === n) {
      const only = this._chunks.pop();
      this._bufferedBytes = 0;
      return only;
    }
    const merged = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._bufferedBytes);
    const out = merged.subarray(0, n);
    const rest = merged.subarray(n);
    this._chunks = rest.length > 0 ? [rest] : [];
    this._bufferedBytes = rest.length;
    return out;
  }

  _peekHeader(maxBytes) {
    if (this._chunks.length === 0) return Buffer.alloc(0);
    if (this._chunks.length === 1) return this._chunks[0].subarray(0, Math.min(maxBytes, this._chunks[0].length));
    const merged = Buffer.concat(this._chunks, this._bufferedBytes);
    this._chunks = [merged];
    return merged.subarray(0, Math.min(maxBytes, merged.length));
  }

  connect() {
    if (this._connectStarted) {
      return Promise.reject(new Error('LoopbackWebSocket 不支持重复连接'));
    }
    this._connectStarted = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this._forceClose();
          reject(err);
        } else {
          resolve(this);
        }
      };

      const timer = setTimeout(() => done(new Error('本地 WebSocket 握手超时')), this.connectTimeoutMs);
      timer.unref?.();

      const key = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');

      const sock = createConnection({ host: this.host, port: this.port, family: this.isIpv6 ? 6 : 4 });
      this.socket = sock;
      sock.setNoDelay(true);

      sock.on('connect', () => {
        const req = [
          `GET ${this.path} HTTP/1.1`,
          `Host: ${this.hostHeader}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n');
        sock.write(req);
      });

      sock.on('data', (chunk) => {
        if (this.readyState >= 2) return;
        this._chunks.push(chunk);
        this._bufferedBytes += chunk.length;

        if (!this._handshakeDone) {
          const preview = this._peekHeader(MAX_HANDSHAKE_BYTES + 4);
          const headerEnd = preview.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            if (this._bufferedBytes > MAX_HANDSHAKE_BYTES) {
              done(new Error('握手响应头超出长度限制'));
            }
            return;
          }
          if (headerEnd > MAX_HANDSHAKE_BYTES) {
            done(new Error('握手响应头超出长度限制'));
            return;
          }
          const rawHeader = this._consume(headerEnd + 4).subarray(0, headerEnd).toString('latin1');
          try {
            validateHandshakeResponse(rawHeader, expectedAccept);
          } catch (err) {
            done(err);
            return;
          }
          this._handshakeDone = true;
          this.readyState = 1;
          done(null);
          this.emit('open');
        }

        this._drainFrames();
      });

      sock.on('error', (err) => {
        if (!settled) done(err);
        else this._forceClose();
      });

      sock.on('close', () => {
        if (!settled) done(new Error('WebSocket 连接提前关闭'));
        else this._forceClose();
      });
    });
  }

  send(text) {
    if (this.readyState !== 1 || !this.socket || this.socket.destroyed) {
      throw new Error('WebSocket 未处于打开状态');
    }
    const payload = Buffer.from(String(text), 'utf8');
    if (payload.length > MAX_OUTBOUND_BYTES) {
      throw new Error('出站消息超出大小限制');
    }
    if (this.socket.writableLength > MAX_OUTBOUND_BYTES * 2) {
      throw new Error('出站缓冲区背压超限');
    }
    this.socket.write(encodeClientFrame(0x1, payload));
  }

  _failProtocol(closeCode = 1002) {
    if (this.readyState === 1 && this.socket && !this.socket.destroyed) {
      this.readyState = 2;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(closeCode, 0);
      try {
        this.socket.end(encodeClientFrame(0x8, body));
      } catch {}
    }
    setTimeout(() => this._forceClose(), 100).unref?.();
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    if (this.readyState === 1 && this.socket && !this.socket.destroyed) {
      this.readyState = 2;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      try {
        this.socket.end(encodeClientFrame(0x8, body));
      } catch {}
      setTimeout(() => this._forceClose(), 200).unref?.();
    } else {
      this._forceClose();
    }
  }

  _forceClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._fragOpcode = 0;
    this._fragParts = [];
    this._fragBytes = 0;
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = null;
    this.emit('close');
  }

  _drainFrames() {
    while (this.readyState === 1 && this._bufferedBytes >= 2) {
      const hdr = this._peekHeader(10);
      const b0 = hdr[0];
      const b1 = hdr[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      // RFC 6455: 未协商扩展时 RSV 必须为 0；服务端下发帧绝不可带掩码
      if (rsv !== 0 || masked) {
        this._failProtocol(1002);
        return;
      }

      const isControl = opcode >= 0x8;
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
        this._failProtocol(1002);
        return;
      }

      if (len === 126) {
        if (this._bufferedBytes < 4) return;
        len = hdr.readUInt16BE(2);
        if (len < 126) { this._failProtocol(1002); return; } // 非最短编码
        offset = 4;
      } else if (len === 127) {
        if (this._bufferedBytes < 10) return;
        const bigLen = hdr.readBigUInt64BE(2);
        if (bigLen < 65536n || (hdr[2] & 0x80) !== 0) {
          this._failProtocol(1002);
          return;
        }
        if (bigLen > BigInt(MAX_MESSAGE_BYTES)) {
          this._failProtocol(1009);
          return;
        }
        len = Number(bigLen);
        offset = 10;
      }

      if (isControl && (!fin || len > 125)) {
        this._failProtocol(1002);
        return;
      }
      if (len > MAX_MESSAGE_BYTES) {
        this._failProtocol(1009);
        return;
      }
      if (opcode === 0x0 && this._fragBytes + len > MAX_MESSAGE_BYTES) {
        this._failProtocol(1009);
        return;
      }
      if (this._bufferedBytes < offset + len) return;

      const raw = this._consume(offset + len);
      const payload = raw.subarray(offset);

      if (opcode === 0x8) {
        // RFC 6455 §7.4 校验 Close 帧状态码与 UTF-8 reason
        if (payload.length === 1) { this._failProtocol(1002); return; }
        if (payload.length >= 2) {
          const code = payload.readUInt16BE(0);
          const validCode =
            (code >= 1000 && code <= 1003) ||
            (code >= 1007 && code <= 1014) ||
            (code >= 3000 && code <= 4999);
          if (!validCode) { this._failProtocol(1002); return; }
          if (payload.length > 2) {
            try { utf8Strict.decode(payload.subarray(2)); } catch { this._failProtocol(1007); return; }
          }
        }
        this.close(1000);
        return;
      }
      if (opcode === 0x9) {
        if (this.socket && !this.socket.destroyed && this.socket.writableLength <= MAX_OUTBOUND_BYTES) {
          try { this.socket.write(encodeClientFrame(0xa, payload)); } catch {}
        }
        continue;
      }
      if (opcode === 0xa) {
        this.emit('pong', payload);
        continue;
      }

      // 数据帧与严格分片状态机
      if (opcode === 0x1 || opcode === 0x2) {
        if (this._fragOpcode !== 0) {
          this._failProtocol(1002);
          return;
        }
        if (fin) {
          if (opcode === 0x1) {
            let text;
            try {
              text = utf8Strict.decode(payload);
            } catch {
              this._failProtocol(1007);
              return;
            }
            this.emit('message', text);
          }
        } else {
          this._fragOpcode = opcode;
          this._fragParts = [Buffer.from(payload)];
          this._fragBytes = payload.length;
        }
      } else if (opcode === 0x0) {
        if (this._fragOpcode === 0) {
          this._failProtocol(1002);
          return;
        }
        this._fragBytes += payload.length;
        if (this._fragBytes > MAX_MESSAGE_BYTES || this._fragParts.length >= MAX_FRAGMENTS) {
          this._failProtocol(1009);
          return;
        }
        this._fragParts.push(Buffer.from(payload));
        if (fin) {
          const full = Buffer.concat(this._fragParts, this._fragBytes);
          const op = this._fragOpcode;
          this._fragOpcode = 0;
          this._fragParts = [];
          this._fragBytes = 0;
          if (op === 0x1) {
            let text;
            try {
              text = utf8Strict.decode(full);
            } catch {
              this._failProtocol(1007);
              return;
            }
            this.emit('message', text);
          }
        }
      }
    }
  }
}
