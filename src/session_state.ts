/**
 * Session 状态追踪 — 维护 session_id → 进程映射
 *
 * 存储: ~/.claude/feishu/session_states.json (JSON 数组)
 * 由 notify.ts hook 写入，由 feishu_bot.ts 读取。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";

// ---- 类型 ----

export interface SessionState {
  session_id: string;
  pid: number;
  tty: string;            // 如 "ttys002"
  transcript_path: string;
  status: "active" | "idle";
  started_at: string;     // ISO
  last_heartbeat: string; // ISO, 用于判断进程是否还活着
}

// ---- 存储路径 ----

const STATE_FILE = resolve(DATA_DIR, "session_states.json");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ---- 读写 ----

function load(): SessionState[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    if (!raw.trim()) return [];
    return JSON.parse(raw) as SessionState[];
  } catch {
    return [];
  }
}

function save(states: SessionState[]): void {
  ensureDir();
  // 清理超过 24h 无心跳的记录
  const cutoff = Date.now() - 24 * 3600_000;
  const alive = states.filter((s) => new Date(s.last_heartbeat).getTime() > cutoff);
  writeFileSync(STATE_FILE, JSON.stringify(alive, null, 2));
}

// ---- 公开 API ----

/** 注册或更新 session（SessionStart 时调用） */
export function registerSession(s: SessionState): void {
  const states = load();
  // 将同一 PID 的旧 session 标记为 idle（进程复用时清理）
  for (const old of states) {
    if (old.pid === s.pid && old.session_id !== s.session_id && old.status === "active") {
      old.status = "idle";
      old.last_heartbeat = new Date().toISOString();
    }
  }
  const idx = states.findIndex((x) => x.session_id === s.session_id);
  if (idx >= 0) {
    states[idx] = { ...states[idx], ...s, last_heartbeat: new Date().toISOString() };
  } else {
    states.push({ ...s, last_heartbeat: new Date().toISOString() });
  }
  save(states);
}

/** 更新心跳时间（每个 hook 调用时可选） */
export function updateHeartbeat(sid: string): void {
  const states = load();
  const s = states.find((x) => x.session_id === sid);
  if (s) {
    s.last_heartbeat = new Date().toISOString();
    save(states);
  }
}

/** 标记 session 为空闲 */
export function markIdle(sid: string): void {
  const states = load();
  const s = states.find((x) => x.session_id === sid);
  if (s) {
    s.status = "idle";
    s.last_heartbeat = new Date().toISOString();
    save(states);
  }
}

/** 按完整 session_id 查询 */
export function getSession(sid: string): SessionState | null {
  return load().find((s) => s.session_id === sid) ?? null;
}

/** 按 session_id 前缀匹配（从卡片文本提取时可能不完整） */
export function findByPrefix(prefix: string): SessionState | null {
  if (prefix.length < 8) return null;
  const states = load();
  // 先精确匹配
  const exact = states.find((s) => s.session_id === prefix);
  if (exact) return exact;
  // 再前缀匹配
  return states.find((s) => s.session_id.startsWith(prefix)) ?? null;
}

/** 列出所有可用 session（进程存活即可，不管 active/idle） */
export function listActive(): SessionState[] {
  return load().filter((s) => (s.status === "active" || s.status === "idle") && isProcessAlive(s.pid));
}

/** 检查进程是否存活 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 清理指定 session */
export function removeSession(sid: string): void {
  save(load().filter((s) => s.session_id !== sid));
}
