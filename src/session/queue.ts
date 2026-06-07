/**
 * 统一消息队列 — 内存存储，退出时持久化到 ./data/messages.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";

export interface QueuedMessage {
  id: string;
  chat_id: string;
  sender: string;
  content: string;
  session_id?: string;
  received_at: string;
  status: "pending" | "delivered";
  delivered_at?: string;
}

// ═══════════════════════════════════════════════════════════════
// 内存存储
// ═══════════════════════════════════════════════════════════════

let messages: QueuedMessage[] = [];

const QUEUE_FILE = config.dataDir + "/messages.json";

export function loadMessageQueue(): void {
  try {
    if (existsSync(QUEUE_FILE)) {
      messages = JSON.parse(readFileSync(QUEUE_FILE, "utf-8")) as QueuedMessage[];
    }
  } catch { messages = []; }
}

export function persistMessageQueue(): void {
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(QUEUE_FILE, JSON.stringify(messages, null, 2));
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════

export function enqueue(msg: QueuedMessage): void {
  messages.push(msg);
}

export function getPending(sessionId?: string): QueuedMessage[] {
  return messages.filter((i) => {
    if (i.status !== "pending") return false;
    if (sessionId !== undefined) return i.session_id === sessionId;
    return true;
  });
}

export function getInboxPending(): QueuedMessage[] {
  return messages.filter((i) => i.status === "pending" && !i.session_id);
}

export function pendingCount(sessionId?: string): number {
  return getPending(sessionId).length;
}

export function markDelivered(msgId: string): void {
  const item = messages.find((i) => i.id === msgId && i.status === "pending");
  if (item) { item.status = "delivered"; item.delivered_at = new Date().toISOString(); }
}

export function listPendingSessions(): { session_id: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of messages) {
    if (item.status === "pending" && item.session_id) {
      map.set(item.session_id, (map.get(item.session_id) ?? 0) + 1);
    }
  }
  return [...map.entries()].map(([session_id, count]) => ({ session_id, count }));
}

export function resetMessageQueue(): void { messages = []; }

export function clearDelivered(): number {
  const before = messages.length;
  messages = messages.filter((i) => i.status === "pending");
  return before - messages.length;
}
