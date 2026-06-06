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
import type { QueuedMessage } from "./message_queue.js";
import { getPending, markDelivered } from "./message_queue.js";
import { detectState } from "./terminal.js";
import type { ClaudeState } from "./terminal.js";
import { isProcessAlive, getSession } from "./session_state.js";

// ---- 类型 ----

export interface OrchestratorDeps {
  sessionId: string;
  tty: string;
  transcriptPath: string;
  pid: number;
  getState?: () => ClaudeState;
  sendViaITerm: (tty: string, message: string) => boolean;
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
  const ok = deps.sendViaITerm(deps.tty, item.content);
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
