/**
 * 投递追踪 — 记录最近一次投递到每个 session 的飞书消息 ID
 *
 * Stop hook 触发时，notify.ts 查询此映射，用 replyCard 引用回复原始消息，
 * 而非 sendChatCard 发送一条孤立的群聊消息。
 *
 * 存储: ~/.claude/feishu/delivery_tracker.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";

// ---- 类型 ----

interface TrackerEntry {
  msgId: string;       // 飞书消息 ID
  timestamp: string;   // ISO
}

type TrackerData = Record<string, TrackerEntry>; // session_id → entry

// ---- 存储 ----

const TRACKER_FILE = resolve(DATA_DIR, "delivery_tracker.json");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): TrackerData {
  if (!existsSync(TRACKER_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TRACKER_FILE, "utf-8")) as TrackerData;
  } catch {
    return {};
  }
}

function save(data: TrackerData): void {
  ensureDir();
  writeFileSync(TRACKER_FILE, JSON.stringify(data));
}

// ---- 公开 API ----

/** 记录一次投递：将飞书消息 ID 关联到目标 session */
export function recordDelivery(sessionId: string, msgId: string): void {
  const data = load();
  data[sessionId] = { msgId, timestamp: new Date().toISOString() };
  save(data);
}

/** 查询最近一次投递到指定 session 的飞书消息 ID，无记录返回 null */
export function getLastDelivery(sessionId: string): string | null {
  return load()[sessionId]?.msgId ?? null;
}

/** 清除指定 session 的投递记录（回复后调用） */
export function clearDelivery(sessionId: string): void {
  const data = load();
  delete data[sessionId];
  save(data);
}
