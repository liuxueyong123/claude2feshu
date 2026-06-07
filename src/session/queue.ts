/**
 * 统一消息队列 — 数据存储在 storage
 */
import { storage, type QueuedMessage } from "../storage.js";
export type { QueuedMessage };

export function enqueue(msg: QueuedMessage): void { storage.messages.push(msg); }

export function getPending(sessionId?: string): QueuedMessage[] {
  return storage.messages.filter(i => i.status === "pending" && (sessionId === undefined || i.session_id === sessionId));
}

export function getInboxPending(): QueuedMessage[] {
  return storage.messages.filter(i => i.status === "pending" && !i.session_id);
}

export function pendingCount(sessionId?: string): number { return getPending(sessionId).length; }

export function markDelivered(msgId: string): void {
  const item = storage.messages.find(i => i.id === msgId && i.status === "pending");
  if (item) { item.status = "delivered"; item.delivered_at = new Date().toISOString(); }
}

export function listPendingSessions(): { session_id: string; count: number }[] {
  const map = new Map<string, number>();
  for (const i of storage.messages) {
    if (i.status === "pending" && i.session_id) map.set(i.session_id, (map.get(i.session_id) ?? 0) + 1);
  }
  return [...map.entries()].map(([session_id, count]) => ({ session_id, count }));
}

export function clearDelivered(): number {
  const before = storage.messages.length;
  storage.messages = storage.messages.filter(i => i.status === "pending");
  return before - storage.messages.length;
}
