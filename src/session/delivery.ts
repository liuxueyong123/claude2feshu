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
import { DATA_DIR } from "../config.js";

// ---- 类型 ----

interface TrackerEntry {
  msgId: string;       // 飞书消息 ID
  timestamp: string;   // ISO
}

type TrackerData = Record<string, TrackerEntry>; // session_id → entry

// ---- 存储 ----

function dataDir(): string {
  return process.env.FEISHU_DATA_DIR || DATA_DIR;
}

function trackerFile(): string {
  return resolve(dataDir(), "delivery_tracker.json");
}

function ensureDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): TrackerData {
  const file = trackerFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as TrackerData;
  } catch {
    return {};
  }
}

function save(data: TrackerData): void {
  ensureDir();
  writeFileSync(trackerFile(), JSON.stringify(data));
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

/**
 * 统一投递编排 — 从 inbox 和 session 队列中选择一条可达消息投递
 *
 * 优先级:
 *   1. 绑定到当前 session 的消息 (session_id === currentSessionId)
 *   2. Inbox 消息 (session_id === undefined, 任意 session 可处理)
 *   3. 绑定到其他已退出 session 的消息 (目标 session 进程已死)
 *
 * 不会投递绑定到其他活跃 session 的消息，避免消息被错误路由。
 */
import type { QueuedMessage } from "./queue.js";
import { getPending, markDelivered } from "./queue.js";
import { detectState } from "../terminal.js";
import type { ClaudeState } from "../terminal.js";
import { isProcessAlive, getSession } from "./state.js";
// recordDelivery is defined in this file

// ---- 类型 ----

export interface OrchestratorDeps {
  sessionId: string;
  tty: string;
  transcriptPath: string;
  pid: number;
  getState?: () => ClaudeState;
  sendToTerminal: (tty: string, message: string) => boolean;
  replyCard: (msgId: string, title: string, content: string, color: string, sessionId?: string) => Promise<unknown>;
}

export interface OrchestratorResult {
  sent: number;
  failed: number;
  remaining: number;
  reason: string;
  /** 每条已发送消息的结果摘要 */
  details: string[];
}

// ---- 公开 API ----

/**
 * 投递一条可达消息。
 *
 * 每个 hook/轮询触发只发送一条，后续消息等待 Claude 完成后由下一次 hook 触发，
 * 避免后台长轮询和多入口批量消费同一队列。
 */
export async function deliverNextPending(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const messages = collectMessages(deps.sessionId);
  if (!messages.length) {
    return { sent: 0, failed: 0, remaining: 0, reason: "done", details: [] };
  }

  const state = normalizeState(deps);
  if (state !== "waiting") {
    return {
      sent: 0,
      failed: 0,
      remaining: messages.length,
      reason: state === "gone" ? "not_waiting" : "busy",
      details: [`⏳ ${messages.length} 条保留在队列中`],
    };
  }

  const item = messages[0];
  const ok = deps.sendToTerminal(deps.tty, item.content);
  if (!ok) {
    await deps.replyCard(
      item.id,
      "⚠️ 投递失败",
      "无法写入终端，指令已保留在队列中。\n\n请确认终端软件正在运行。",
      "yellow",
      deps.sessionId,
    );
    return {
      sent: 0,
      failed: 1,
      remaining: messages.length,
      reason: "send_failed",
      details: ["❌ 1 条发送失败"],
    };
  }

  markDelivered(item.id);
  recordDelivery(deps.sessionId, item.id);
  await deps.replyCard(
    item.id,
    "✅ 已投递",
    `指令已发送到终端处理。\n\n> ${item.content.slice(0, 200)}`,
    "green",
    deps.sessionId,
  );

  return {
    sent: 1,
    failed: 0,
    remaining: messages.length - 1,
    reason: "done",
    details: [`✅ [${item.sender}]: ${item.content.slice(0, 80)}`],
  };
}

// ---- 内部 ----

function collectMessages(currentSessionId: string): QueuedMessage[] {
  const all = getPending();
  if (!all.length) return [];

  // 收集已退出 session 的 ID，避免每条消息都重复查 session_state
  const deadSessions = new Set<string>();
  for (const msg of all) {
    if (msg.session_id && msg.session_id !== currentSessionId && !deadSessions.has(msg.session_id)) {
      const session = getSession(msg.session_id);
      if (!session || !isProcessAlive(session.pid)) {
        deadSessions.add(msg.session_id);
      }
    }
  }

  // 按优先级分组: 当前 session > inbox > 其他已退出 session
  const currentSession: QueuedMessage[] = [];
  const inbox: QueuedMessage[] = [];
  const deadSession: QueuedMessage[] = [];

  for (const msg of all) {
    if (!msg.session_id) {
      inbox.push(msg);
    } else if (msg.session_id === currentSessionId) {
      currentSession.push(msg);
    } else if (deadSessions.has(msg.session_id)) {
      deadSession.push(msg);
    }
    // 跳过: 属于其他活跃 session 的消息
  }

  return [...currentSession, ...inbox, ...deadSession];
}

function normalizeState(deps: OrchestratorDeps): ClaudeState {
  const state = deps.getState ? deps.getState() : detectState(deps.transcriptPath);
  return state === "gone" && isProcessAlive(deps.pid) ? "waiting" : state;
}
