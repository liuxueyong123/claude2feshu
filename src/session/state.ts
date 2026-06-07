/**
 * Session 状态追踪 — 数据存储在 storage
 */
import { storage, type SessionState } from "../utils/storage.js";
export type { SessionState };

export function registerSession(s: SessionState): void {
  const now = new Date().toISOString();
  const hasExisting = storage.sessions.some((item) => item.session_id === s.session_id);
  const next = storage.sessions.map((item) => {
    if (item.session_id === s.session_id) {
      return { ...item, ...s, last_heartbeat: now };
    }
    if (item.pid === s.pid && item.status === "active") {
      return { ...item, status: "idle" as const, last_heartbeat: now };
    }
    return item;
  });
  storage.sessions = hasExisting ? next : [...next, { ...s, last_heartbeat: now }];
}

export function updateHeartbeat(sid: string): void {
  const now = new Date().toISOString();
  storage.sessions = storage.sessions.map((item) => (
    item.session_id === sid ? { ...item, last_heartbeat: now } : item
  ));
}

export function markIdle(sid: string): void {
  const now = new Date().toISOString();
  storage.sessions = storage.sessions.map((item) => (
    item.session_id === sid ? { ...item, status: "idle", last_heartbeat: now } : item
  ));
}

export function getSession(sid: string): SessionState | null {
  return storage.sessions.find(s => s.session_id === sid) ?? null;
}

export function findByPrefix(prefix: string): SessionState | null {
  if (prefix.length < 8) return null;
  return storage.sessions.find(s => s.session_id === prefix) ?? storage.sessions.find(s => s.session_id.startsWith(prefix)) ?? null;
}

export function listActive(): SessionState[] {
  return storage.sessions.filter(s => (s.status === "active" || s.status === "idle") && isProcessAlive(s.pid));
}

/** 返回状态为 active 但进程已死的 session（窗口关闭/SIGHUP 导致 hook 来不及触发） */
export function drainDeadSessions(): SessionState[] {
  const dead: SessionState[] = [];
  storage.sessions = storage.sessions.map((s) => {
    if (s.status === "active" && !isProcessAlive(s.pid)) {
      dead.push(s);
      return { ...s, status: "idle" as const };
    }
    return s;
  });
  return dead;
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function removeSession(sid: string): void {
  storage.sessions = storage.sessions.filter(s => s.session_id !== sid);
}
