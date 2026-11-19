/**
 * 基于排他锁文件（O_CREAT | O_EXCL）的跨进程单写者租约锁。
 * 绝不强抢仍在存活且未过期的持有者，防止双 sidecar 并发覆盖账本与状态。
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const LEASE_TTL_MS = 12000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class OwnerLease {
  constructor(leaseFile) {
    this.leaseFile = leaseFile;
    this.token = randomUUID();
    this.startedAt = Date.now();
    this.owned = false;
    this._timer = null;
  }

  async _readLease() {
    try {
      const raw = await readFile(this.leaseFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && typeof data.token === 'string') return data;
    } catch {}
    return null;
  }

  _payload() {
    return JSON.stringify({
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
    });
  }

  /**
   * 通过排他创建（wx）抢占所有权；仅在确认已有租约对应 PID 已退出且超时后才回收旧锁重试。
   */
  async claim() {
    if (!this.leaseFile) {
      this.owned = true;
      return true;
    }
    await mkdir(dirname(this.leaseFile), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(this.leaseFile, 'wx', 0o600);
        try {
          await fh.writeFile(this._payload(), 'utf8');
        } finally {
          await fh.close();
        }
        this.owned = true;
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') {
          this.owned = false;
          return false;
        }
        const existing = await this._readLease();
        const deadOrExpired =
          !existing ||
          (!isPidAlive(existing.pid) && Date.now() - Number(existing.heartbeatAt || 0) > LEASE_TTL_MS);
        if (!deadOrExpired) {
          this.owned = false;
          return false;
        }
        // 仅清理确认已死亡且过期的陈旧锁后重试一次排他创建
        try { await unlink(this.leaseFile); } catch {}
      }
    }
    this.owned = false;
    return false;
  }

  async renew() {
    if (!this.owned || !this.leaseFile) return false;
    const existing = await this._readLease();
    if (!existing || existing.token !== this.token) {
      this.owned = false;
      return false;
    }
    const tmp = `${this.leaseFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, this._payload(), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.leaseFile);
      return true;
    } catch {
      try { await unlink(tmp); } catch {}
      this.owned = false;
      return false;
    }
  }

  startHeartbeat(onLost = () => {}) {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      const ok = await this.renew();
      if (!ok) onLost();
    }, 4000);
    this._timer.unref?.();
  }

  async release() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!this.owned || !this.leaseFile) {
      this.owned = false;
      return;
    }
    this.owned = false;
    try {
      const existing = await this._readLease();
      if (existing?.token === this.token) {
        await unlink(this.leaseFile);
      }
    } catch {}
  }
}
