/**
 * 投递追踪 + 统一投递编排
 * 内存存储，退出时持久化到 ./data/delivery.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";
import type { QueuedMessage } from "./queue.js";
import { getPending, markDelivered } from "./queue.js";
import { detectState } from "../terminal.js";
import type { ClaudeState } from "../terminal.js";
import { isProcessAlive, getSession } from "./state.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

interface TrackerEntry { msgId: string; timestamp: string; }
type TrackerData = Record<string, TrackerEntry>;

export interface OrchestratorDeps {
  sessionId: string; tty: string; transcriptPath: string; pid: number;
  getState?: () => ClaudeState;
  sendToTerminal: (tty: string, message: string) => boolean;
  replyCard: (msgId: string, title: string, content: string, color: string, sessionId?: string) => Promise<unknown>;
}

export interface OrchestratorResult { sent: number; failed: number; remaining: number; reason: string; details: string[]; }

// ═══════════════════════════════════════════════════════════════
// 内存存储
// ═══════════════════════════════════════════════════════════════

let tracker: TrackerData = {};

const TRACKER_FILE = config.dataDir + "/delivery.json";

export function loadDeliveryTracker(): void {
  try { if (existsSync(TRACKER_FILE)) tracker = JSON.parse(readFileSync(TRACKER_FILE, "utf-8")) as TrackerData; } catch { tracker = {}; }
}

export function persistDeliveryTracker(): void {
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(TRACKER_FILE, JSON.stringify(tracker));
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// 投递追踪 API
// ═══════════════════════════════════════════════════════════════

export function recordDelivery(sessionId: string, msgId: string): void {
  tracker[sessionId] = { msgId, timestamp: new Date().toISOString() };
}

export function getLastDelivery(sessionId: string): string | null {
  return tracker[sessionId]?.msgId ?? null;
}

export function resetDeliveryTracker(): void { tracker = {}; }

export function clearDelivery(sessionId: string): void {
  delete tracker[sessionId];
}

// ═══════════════════════════════════════════════════════════════
// 投递编排 API
// ═══════════════════════════════════════════════════════════════

export async function deliverNextPending(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const messages = collectMessages(deps.sessionId);
  if (!messages.length) return { sent: 0, failed: 0, remaining: 0, reason: "done", details: [] };

  const state = normalizeState(deps);
  if (state !== "waiting") {
    return { sent: 0, failed: 0, remaining: messages.length, reason: state === "gone" ? "not_waiting" : "busy", details: [`⏳ ${messages.length} 条保留在队列中`] };
  }

  const item = messages[0];
  const ok = deps.sendToTerminal(deps.tty, item.content);
  if (!ok) {
    await deps.replyCard(item.id, "⚠️ 投递失败", "无法写入终端，指令已保留在队列中。\n\n请确认终端软件正在运行。", "yellow", deps.sessionId);
    return { sent: 0, failed: 1, remaining: messages.length, reason: "send_failed", details: ["❌ 1 条发送失败"] };
  }

  markDelivered(item.id);
  recordDelivery(deps.sessionId, item.id);
  await deps.replyCard(item.id, "✅ 已投递", `指令已发送到终端处理。\n\n> ${item.content.slice(0, 200)}`, "green", deps.sessionId);

  return { sent: 1, failed: 0, remaining: messages.length - 1, reason: "done", details: [`✅ [${item.sender}]: ${item.content.slice(0, 80)}`] };
}

// ═══════════════════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════════════════

function collectMessages(currentSessionId: string): QueuedMessage[] {
  const all = getPending();
  if (!all.length) return [];
  const deadSessions = new Set<string>();
  for (const msg of all) {
    if (msg.session_id && msg.session_id !== currentSessionId && !deadSessions.has(msg.session_id)) {
      const session = getSession(msg.session_id);
      if (!session || !isProcessAlive(session.pid)) deadSessions.add(msg.session_id);
    }
  }
  const current: QueuedMessage[] = [], inbox: QueuedMessage[] = [], dead: QueuedMessage[] = [];
  for (const msg of all) {
    if (!msg.session_id) inbox.push(msg);
    else if (msg.session_id === currentSessionId) current.push(msg);
    else if (deadSessions.has(msg.session_id)) dead.push(msg);
  }
  return [...current, ...inbox, ...dead];
}

function normalizeState(deps: OrchestratorDeps): ClaudeState {
  const state = deps.getState ? deps.getState() : detectState(deps.transcriptPath);
  return state === "gone" && isProcessAlive(deps.pid) ? "waiting" : state;
}
