import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { LoopbackWebSocket } from '../src/local-ws.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildServerFrame(opcode, payload, { fin = true, rsv = 0, masked = false } = {}) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const first = (fin ? 0x80 : 0x00) | (rsv & 0x70) | (opcode & 0x0f);
  const maskBit = masked ? 0x80 : 0x00;
  if (buf.length < 126) {
    const hdr = Buffer.from([first, maskBit | buf.length]);
    return masked ? Buffer.concat([hdr, Buffer.from([1, 2, 3, 4]), buf]) : Buffer.concat([hdr, buf]);
  }
  const hdr = Buffer.alloc(4);
  hdr[0] = first;
  hdr[1] = maskBit | 126;
  hdr.writeUInt16BE(buf.length, 2);
  return Buffer.concat([hdr, buf]);
}

function decodeClientFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (p + len > buf.length) break;
    const data = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) data[i] = masked ? (buf[p + i] ^ mask[i & 3]) : buf[p + i];
    frames.push({ opcode, masked, text: data.toString('utf8') });
    off = p + len;
  }
  return frames;
}

function startMockWsServer(onOpen, onClientData = () => {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = buf.subarray(0, end).toString('utf8');
          const key = head.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
          const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
          );
          upgraded = true;
          buf = buf.subarray(end + 4);
          onOpen(socket);
          if (buf.length > 0) onClientData(buf);
        } else {
          onClientData(chunk);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('LoopbackWebSocket 拒绝非本地回环、凭据与非 ws 协议', () => {
  assert.throws(() => new LoopbackWebSocket('ws://example.com:9222/test'));
  assert.throws(() => new LoopbackWebSocket('wss://127.0.0.1:9222/test'));
  assert.throws(() => new LoopbackWebSocket('ws://user:pass@127.0.0.1:9222/test'));
});

test('LoopbackWebSocket 真实校验客户端掩码、Ping 自动回 Pong、半包与粘包分片重组', async (t) => {
  const received = [];
  let clientRaw = Buffer.alloc(0);

  const { server, port } = await startMockWsServer(
    (sock) => {
      // 显式切分半包 + 粘包：Ping + 跨 UTF-8 分片文本 + 完整 JSON
      const ping = buildServerFrame(0x9, 'hi');
      const frag1 = buildServerFrame(0x1, Buffer.from('你好', 'utf8').subarray(0, 4), { fin: false });
      const frag2 = buildServerFrame(0x0, Buffer.from('你好', 'utf8').subarray(4), { fin: true });
      const combined = Buffer.concat([ping, frag1, frag2]);
      // 故意逐片半包投递
      sock.write(combined.subarray(0, 3));
      setTimeout(() => sock.write(combined.subarray(3, 9)), 15);
      setTimeout(() => sock.write(combined.subarray(9)), 30);
    },
    (chunk) => { clientRaw = Buffer.concat([clientRaw, chunk]); }
  );
  t.after(() => server.close());

  const ws = new LoopbackWebSocket(`ws://127.0.0.1:${port}/devtools/page/abc`);
  ws.on('message', (msg) => received.push(msg));
  await ws.connect();
  ws.send('{"id":1}');

  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(received, ['你好']);

  const clientFrames = decodeClientFrames(clientRaw);
  const textFrame = clientFrames.find((f) => f.opcode === 0x1);
  const pongFrame = clientFrames.find((f) => f.opcode === 0xa);
  assert.ok(textFrame && textFrame.masked === true && textFrame.text === '{"id":1}');
  assert.ok(pongFrame && pongFrame.masked === true && pongFrame.text === 'hi');

  ws.close();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(ws.readyState, 3);
});

test('LoopbackWebSocket 严格拒收服务端带掩码或非零 RSV 协议违规帧', async (t) => {
  let closed = false;
  const { server, port } = await startMockWsServer((sock) => {
    sock.write(buildServerFrame(0x1, 'bad', { masked: true }));
  });
  t.after(() => server.close());

  const ws = new LoopbackWebSocket(`ws://127.0.0.1:${port}/devtools/page/bad`);
  ws.on('close', () => { closed = true; });
  await ws.connect();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(closed, true);
});
