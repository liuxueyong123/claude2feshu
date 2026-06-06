/**
 * Session 专用消息队列 — 管理 session 维度的延迟投递消息
 *
 * 存储: ~/.claude/feishu/feishu_session_queue.jsonl
 * 写入: feishu_bot.ts (检测到引用消息且 session 非 waiting 时)
 * 读取: notify.ts / feishu_bot.ts 投递队列时读取 pending，发送成功后标记 delivered
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.js";

// ---- 类型 ----

export interface QueuedMessage {
  id: string;          // 飞书消息 ID
  chat_id: string;     // 飞书群聊 ID（用于回复）
  sender: string;      // 发送者 ID
  content: string;     // 用户消息（纯文本）
  session_id: string;  // 目标 session
  received_at: string; // ISO
  status: "pending" | "delivered";
}

// ---- 存储路径 ----

const QUEUE_FILE = resolve(DATA_DIR, "feishu_session_queue.jsonl");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ---- 读写 ----

function load(): QueuedMessage[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return readFileSync(QUEUE_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as QueuedMessage; } catch { return null; }
      })
      .filter((x): x is QueuedMessage => x !== null);
  } catch {
    return [];
  }
}

function save(items: QueuedMessage[]): void {
  ensureDir();
  writeFileSync(QUEUE_FILE, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

// ---- 公开 API ----

/** 入队一条待投递消息 */
export function enqueue(msg: QueuedMessage): void {
  ensureDir();
  writeFileSync(QUEUE_FILE, JSON.stringify(msg) + "\n", { flag: "a" });
}

/** 读取指定 session 的所有 pending 消息。发送成功后由 markDelivered() 确认。 */
export function dequeueAll(sid: string): QueuedMessage[] {
  return getPending(sid);
}

/** 获取指定 session 的 pending 消息数量 */
export function pendingCount(sid: string): number {
  return getPending(sid).length;
}

/** 获取指定 session 的所有 pending 消息（不取出） */
export function getPending(sid: string): QueuedMessage[] {
  return load().filter((i) => i.session_id === sid && i.status === "pending");
}

/** 标记单条消息为 delivered（确认已成功写入终端后调用） */
export function markDelivered(msgId: string): void {
  const items = load();
  const item = items.find((i) => i.id === msgId && i.status === "pending");
  if (item) {
    item.status = "delivered";
    save(items);
  }
}

/** 列出所有有 pending 消息的 session */
export function listPendingSessions(): { session_id: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of load()) {
    if (item.status === "pending") {
      map.set(item.session_id, (map.get(item.session_id) ?? 0) + 1);
    }
  }
  return [...map.entries()].map(([session_id, count]) => ({ session_id, count }));
}
