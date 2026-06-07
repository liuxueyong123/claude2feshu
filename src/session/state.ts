/**
 * Session 状态追踪 — 数据存储在 storage
 */
import { storage, type SessionState } from "../storage.js";
export type { SessionState };

export function registerSession(s: SessionState): void {
  const { sessions } = storage;
  const now = new Date().toISOString();
  for (const old of sessions) {
    if (old.pid === s.pid && old.session_id !== s.session_id && old.status === "active") {
      old.status = "idle"; old.last_heartbeat = now;
    }
  }
  const idx = sessions.findIndex(x => x.session_id === s.session_id);
  if (idx >= 0) sessions[idx] = { ...sessions[idx], ...s, last_heartbeat: now };
  else sessions.push({ ...s, last_heartbeat: now });
}

export function updateHeartbeat(sid: string): void {
  const s = storage.sessions.find(x => x.session_id === sid);
  if (s) s.last_heartbeat = new Date().toISOString();
}

export function markIdle(sid: string): void {
  const s = storage.sessions.find(x => x.session_id === sid);
  if (s) { s.status = "idle"; s.last_heartbeat = new Date().toISOString(); }
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

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function removeSession(sid: string): void {
  storage.sessions = storage.sessions.filter(s => s.session_id !== sid);
}
