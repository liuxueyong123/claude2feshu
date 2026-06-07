/**
 * 统一消息队列 — 管理所有待投递到 Claude Code 终端的飞书消息
 *
 * inbox 消息 (session_id = undefined): 任意可用 session 均可处理
 * session 消息 (session_id = 指定值): 仅由绑定的 session 处理
 *
 * 存储: ~/.claude/feishu/message_queue.jsonl
 * 写入: feishu_bot.ts (收到消息且无法立即投递时)
 * 读取: delivery_orchestrator.ts (hook 触发时单条投递)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

// ---- 类型 ----

export interface QueuedMessage {
  id: string;              // 飞书消息 ID (唯一)
  chat_id: string;         // 飞书群聊 ID（用于回复）
  sender: string;          // 发送者 ID
  content: string;         // 消息文本（纯文本）
  session_id?: string;     // 目标 session (undefined = 任意 session 可处理)
  received_at: string;     // ISO
  status: "pending" | "delivered";
  delivered_at?: string;   // ISO
}

// ---- 存储路径 ----

function dataDir(): string {
  return process.env.FEISHU_DATA_DIR || config.dataDir;
}

function queueFile(): string {
  return resolve(dataDir(), "message_queue.jsonl");
}

function ensureDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---- 读写 ----

function load(): QueuedMessage[] {
  const file = queueFile();
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8")
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
  writeFileSync(queueFile(), items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

// ---- 公开 API ----

/** 入队一条待投递消息 */
export function enqueue(msg: QueuedMessage): void {
  ensureDir();
  writeFileSync(queueFile(), JSON.stringify(msg) + "\n", { flag: "a" });
}

/** 获取所有 pending 消息，可选按 session 过滤 */
export function getPending(sessionId?: string): QueuedMessage[] {
  return load().filter((i) => {
    if (i.status !== "pending") return false;
    if (sessionId !== undefined) return i.session_id === sessionId;
    return true;
  });
}

/** 获取所有不绑定 session 的 inbox pending 消息 */
export function getInboxPending(): QueuedMessage[] {
  return load().filter((i) => i.status === "pending" && !i.session_id);
}

/** 获取 pending 消息数量，可选按 session 过滤 */
export function pendingCount(sessionId?: string): number {
  return getPending(sessionId).length;
}

/** 标记单条消息为 delivered */
export function markDelivered(msgId: string): void {
  const items = load();
  const deliveredAt = new Date().toISOString();
  const next = items.map((item) =>
    item.id === msgId && item.status === "pending"
      ? { ...item, status: "delivered" as const, delivered_at: deliveredAt }
      : item,
  );
  if (next.some((item, idx) => item !== items[idx])) save(next);
}

/** 列出所有有 pending 消息的 session（不含 inbox 消息） */
export function listPendingSessions(): { session_id: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of load()) {
    if (item.status === "pending" && item.session_id) {
      map.set(item.session_id, (map.get(item.session_id) ?? 0) + 1);
    }
  }
  return [...map.entries()].map(([session_id, count]) => ({ session_id, count }));
}

/** 清理所有 delivered 消息，保留 pending */
export function clearDelivered(): number {
  const items = load();
  const keep = items.filter((i) => i.status === "pending");
  const removed = items.length - keep.length;
  save(keep);
  return removed;
}
