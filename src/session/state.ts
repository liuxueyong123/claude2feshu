/**
 * Session 状态追踪 — 内存存储，退出时持久化到 ./data/sessions.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";

export interface SessionState {
  session_id: string;
  pid: number;
  tty: string;
  transcript_path: string;
  status: "active" | "idle";
  started_at: string;
  last_heartbeat: string;
}

// ═══════════════════════════════════════════════════════════════
// 内存存储
// ═══════════════════════════════════════════════════════════════

let states: SessionState[] = [];

const STATE_FILE = config.dataDir + "/sessions.json";

export function loadSessionStates(): void {
  try {
    if (existsSync(STATE_FILE)) {
      states = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as SessionState[];
    }
  } catch { states = []; }
  // 清理超过 24h 的记录
  const cutoff = Date.now() - 24 * 3600_000;
  states = states.filter((s) => new Date(s.last_heartbeat).getTime() > cutoff);
}

export function persistSessionStates(): void {
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    const cutoff = Date.now() - 24 * 3600_000;
    const alive = states.filter((s) => new Date(s.last_heartbeat).getTime() > cutoff);
    writeFileSync(STATE_FILE, JSON.stringify(alive, null, 2));
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════

export function registerSession(s: SessionState): void {
  const now = new Date().toISOString();
  // 将同一 PID 的旧 session 标记为 idle
  for (const old of states) {
    if (old.pid === s.pid && old.session_id !== s.session_id && old.status === "active") {
      old.status = "idle"; old.last_heartbeat = now;
    }
  }
  const idx = states.findIndex((x) => x.session_id === s.session_id);
  if (idx >= 0) {
    states[idx] = { ...states[idx], ...s, last_heartbeat: now };
  } else {
    states.push({ ...s, last_heartbeat: now });
  }
}

export function updateHeartbeat(sid: string): void {
  const s = states.find((x) => x.session_id === sid);
  if (s) s.last_heartbeat = new Date().toISOString();
}

export function markIdle(sid: string): void {
  const s = states.find((x) => x.session_id === sid);
  if (s) { s.status = "idle"; s.last_heartbeat = new Date().toISOString(); }
}

export function getSession(sid: string): SessionState | null {
  return states.find((s) => s.session_id === sid) ?? null;
}

export function findByPrefix(prefix: string): SessionState | null {
  if (prefix.length < 8) return null;
  const exact = states.find((s) => s.session_id === prefix);
  if (exact) return exact;
  return states.find((s) => s.session_id.startsWith(prefix)) ?? null;
}

export function listActive(): SessionState[] {
  return states.filter((s) => (s.status === "active" || s.status === "idle") && isProcessAlive(s.pid));
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function resetSessionStates(): void { states = []; }

export function removeSession(sid: string): void {
  states = states.filter((s) => s.session_id !== sid);
}
