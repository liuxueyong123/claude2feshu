/**
 * 投递追踪 + 统一投递编排 — 数据存储在 storage
 */
import { storage } from "../utils/storage.js";
import type { QueuedMessage } from "../utils/storage.js";
import { getPending, markDelivered } from "./queue.js";
import { detectState } from "../utils/terminal.js";
import type { ClaudeState } from "../utils/terminal.js";
import { isProcessAlive, getSession } from "./state.js";

export interface OrchestratorDeps {
  sessionId: string; tty: string; transcriptPath: string; pid: number;
  getState?: () => ClaudeState;
  sendToTerminal: (tty: string, msg: string) => boolean;
  replyCard: (msgId: string, title: string, content: string, color: string, sessionId?: string) => Promise<unknown>;
}

export interface OrchestratorResult { sent: number; failed: number; remaining: number; reason: string; details: string[]; }

// ── 投递追踪 ────────────────────────────────────────────────

export function recordDelivery(sessionId: string, msgId: string): void {
  storage.delivery = {
    ...storage.delivery,
    [sessionId]: { msgId, timestamp: new Date().toISOString() },
  };
}

export function getLastDelivery(sessionId: string): string | null {
  return storage.delivery[sessionId]?.msgId ?? null;
}

export function clearDelivery(sessionId: string): void {
  const { [sessionId]: _removed, ...next } = storage.delivery;
  storage.delivery = next;
}

// ── 投递编排 ────────────────────────────────────────────────

export async function deliverNextPending(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const messages = collectMessages(deps.sessionId);
  if (!messages.length) return { sent: 0, failed: 0, remaining: 0, reason: "done", details: [] };
  const state = normalizeState(deps);
  if (state !== "waiting") return { sent: 0, failed: 0, remaining: messages.length, reason: state === "gone" ? "not_waiting" : "busy", details: [`⏳ ${messages.length} 条保留`] };
  const item = messages[0];
  if (!deps.sendToTerminal(deps.tty, item.content)) {
    await deps.replyCard(item.id, "⚠️ 投递失败", "无法写入终端，指令已保留。\n\n请确认终端软件正在运行。", "yellow", deps.sessionId);
    return { sent: 0, failed: 1, remaining: messages.length, reason: "send_failed", details: ["❌ 1 条发送失败"] };
  }
  markDelivered(item.id);
  recordDelivery(deps.sessionId, item.id);
  await deps.replyCard(item.id, "✅ 已投递", `指令已发送到终端处理。\n\n> ${item.content.slice(0, 200)}`, "green", deps.sessionId);
  return { sent: 1, failed: 0, remaining: messages.length - 1, reason: "done", details: [`✅ [${item.sender}]: ${item.content.slice(0, 80)}`] };
}

function collectMessages(sid: string): QueuedMessage[] {
  const all = getPending();
  if (!all.length) return [];
  const dead = new Set<string>();
  for (const m of all) {
    if (m.session_id && m.session_id !== sid && !dead.has(m.session_id)) {
      const s = getSession(m.session_id); if (!s || !isProcessAlive(s.pid)) dead.add(m.session_id);
    }
  }
  const cur: QueuedMessage[] = [], inbox: QueuedMessage[] = [], d: QueuedMessage[] = [];
  for (const m of all) {
    if (!m.session_id) inbox.push(m);
    else if (m.session_id === sid) cur.push(m);
    else if (dead.has(m.session_id)) d.push(m);
  }
  return [...cur, ...inbox, ...d];
}

function normalizeState(deps: OrchestratorDeps): ClaudeState {
  const s = deps.getState ? deps.getState() : detectState(deps.transcriptPath);
  return s === "gone" && isProcessAlive(deps.pid) ? "waiting" : s;
}
