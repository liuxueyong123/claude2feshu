/** 飞书消息轮询守护进程 — 后台拉取 @消息写入 inbox */
import { writeFileSync, existsSync, readFileSync, unlinkSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, PID_FILE, CHECKPOINT_FILE, DATA_DIR } from "./config.js";
import { log } from "./logger.js";
import { listReceivedMessages, extractText, replyCard, getQuotedMessageId, lookupCardSession } from "./feishu_api.js";
import { enqueueCommand, pendingCount } from "./inbox.js";
import { detectState, sendViaITerm } from "./terminal.js";
import { getSession, findByPrefix, listActive, isProcessAlive } from "./session_state.js";
import { enqueue as enqueueSession, getPending as getSessionPending, markDelivered } from "./session_queue.js";
import type { QueuedMessage } from "./session_queue.js";
import { deliverMessagesSequentially } from "./session_delivery.js";

let running = true;
const activeDeliveries = new Set<string>();

function loadCkpt(): string {
  if (!existsSync(CHECKPOINT_FILE)) return "";
  try {
    return (JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8")) as { last_msg_id?: string }).last_msg_id ?? "";
  } catch {
    return "";
  }
}
function saveCkpt(msgId: string, msgTime: string): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ last_msg_id: msgId, last_time: msgTime }));
}

export function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid));
}
export function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* */
  }
}
export function isRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    process.kill(Number(readFileSync(PID_FILE, "utf-8").trim()), 0);
    return true;
  } catch {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* */
    }
    return false;
  }
}

process.on("SIGTERM", () => {
  running = false;
  log("SIGTERM, 退出中...");
});
process.on("SIGINT", () => {
  running = false;
  log("SIGINT, 退出中...");
});

async function processNewMessages(): Promise<string[]> {
  const lastId = loadCkpt();
  const messages = await listReceivedMessages(20, true);
  const newMsgs = [];
  for (const msg of messages) {
    if (msg.message_id === lastId) break;
    newMsgs.push(msg);
  }
  if (!newMsgs.length) return [];

  log(`收到 ${newMsgs.length} 条新消息等待处理`, "DEBUG");

  for (const msg of newMsgs.reverse()) {
    const id = msg.message_id,
      chatId = msg.chat_id,
      sender = msg.sender?.id ?? "unknown";
    const text = extractText(msg);
    if (!text || text.length < 2) continue;
    log(`📨 [${sender}] ${text.slice(0, 80)}`);

    // ---- 诊断：保存原始消息（引用/回复消息时） ----
    const rawParent = (msg as unknown as Record<string, unknown>).parent_id as string | undefined;
    const rawRoot = (msg as unknown as Record<string, unknown>).root_id as string | undefined;
    if (rawParent || rawRoot) {
      try {
        appendFileSync(
          resolve(DATA_DIR, "message_dump.jsonl"),
          JSON.stringify({
            _ts: new Date().toISOString(),
            message_id: msg.message_id,
            msg_type: msg.msg_type,
            parent_id: rawParent ?? "",
            root_id: rawRoot ?? "",
            body_content: msg.body?.content ?? "",
          }) + "\n",
        );
      } catch {
        /* ignore */
      }
    }

    // ---- Session 路由 ----
    let routed = false;

    // 方式 1: 引用消息中提取 session ID（精确路由到指定 session）
    // 优先查本地 card→session 映射（飞书 API 对 interactive 卡片返回降级内容，无法从 body 解析）
    const quoteId = getQuotedMessageId(msg);
    log(`  quoteId=${quoteId || "(空)"} parent_id=${rawParent || "(空)"} root_id=${rawRoot || "(空)"}`);
    if (quoteId) {
      log(`  引用消息: ${quoteId}`);
      const sid = lookupCardSession(quoteId);
      if (sid) {
        log(`  查找到 session: ${sid.slice(0, 16)}...`);
        await handleSessionMessage(id, chatId, sender, text, sid);
        routed = true;
      } else {
        log(`  未在映射中找到 session ID`, "DEBUG");
      }
    }

    // 方式 2: 无引用时，自动发送到活跃 session（取最近启动的）
    if (!routed) {
      const active = listActive();
      if (active.length >= 1) {
        // 多个 session 时取最近启动的
        const target = active.reduce((a, b) => (a.started_at > b.started_at ? a : b));
        log(`  自动路由到活跃 session: ${target.session_id.slice(0, 16)}...`);
        await handleSessionMessage(id, chatId, sender, text, target.session_id);
        routed = true;
      } else {
        log(`  无活跃 session，走 inbox`, "DEBUG");
      }
    }

    if (routed) continue;

    // 通用 inbox
    enqueueCommand(id, chatId, sender, text, msg.create_time);
    const fallbackReply = buildInboxFallbackReply(text);
    await replyCard(id, fallbackReply.title, fallbackReply.content, fallbackReply.color);
  }
  saveCkpt(messages[0]?.message_id ?? "", messages[0]?.create_time ?? "");
  return newMsgs.map((m) => m.message_id);
}

export function buildInboxFallbackReply(text: string): { title: string; content: string; color: string } {
  return {
    title: "⏳ 等待 Claude Code 启动",
    content:
      `内容：${text.slice(0, 200)}\n\n` +
      "当前没有可用的 Claude Code 终端，消息已暂存到 inbox。\n" +
      "启动 Claude Code 后会自动发送到终端。",
    color: "yellow",
  };
}

// ---- Session 路由处理 ----

async function handleSessionMessage(msgId: string, chatId: string, sender: string, text: string, sid: string): Promise<void> {
  log(`🔗 Session 路由: ${sid.slice(0, 16)}...`);

  const session = getSession(sid) ?? findByPrefix(sid);
  if (!session) {
    log(`  Session 未注册，入队等待`);
    enqueueSession(makeSessionMsg(msgId, chatId, sender, text, sid));
    await replyCard(msgId, "⏳ 会话未运行", `目标 Session 当前未运行，消息已暂存。\n\n将在终端可用时自动发送到终端。`, "yellow", sid);
    return;
  }

  if (!session.transcript_path) {
    enqueueSession(makeSessionMsg(msgId, chatId, sender, text, sid));
    await replyCard(msgId, "⏳ 无法检测状态", `Session 状态未知，消息已暂存。`, "yellow", sid);
    return;
  }

  let state = detectState(session.transcript_path);

  // transcript 无法解析时（刚启动尚无交互消息），若进程确认存活则视为 waiting
  if (state === "gone" && isProcessAlive(session.pid)) {
    log(`  detectState=gone 但进程存活，降级为 waiting`);
    state = "waiting";
  }

  log(`  状态: ${state} (pid=${session.pid}, tty=${session.tty})`);

  switch (state) {
    case "waiting": {
      const ok = sendViaITerm(session.tty, text);
      if (ok) {
        await replyCard(msgId, "✅ 已发送", `消息已自动发送到 Claude Code 终端。\n\n> ${text.slice(0, 200)}`, "green", sid);
        log(`  ✅ 已发送`);
      } else {
        enqueueSession(makeSessionMsg(msgId, chatId, sender, text, sid));
        await replyCard(msgId, "⚠️ 发送失败", "无法通过 iTerm2 发送，消息已入队。请检查 iTerm2 是否在运行。", "yellow", sid);
      }
      break;
    }
    case "busy": {
      enqueueSession(makeSessionMsg(msgId, chatId, sender, text, sid));
      await replyCard(msgId, "⏳ Claude 处理中", `Claude Code 正在执行任务，消息已暂存。\n\n任务完成后将自动发送到终端。`, "yellow", sid);
      log(`  入队等待 (busy → waiting 时自动发送)`);

      scheduleSessionDelivery(sid, session.tty, session.transcript_path, session.pid);
      break;
    }
    case "gone": {
      enqueueSession(makeSessionMsg(msgId, chatId, sender, text, sid));
      await replyCard(msgId, "⏳ 会话已退出", `Claude Code 会话已结束，消息已暂存。\n\n将在终端可用时自动发送到终端。`, "yellow", sid);
      log(`  进程已退出，入队`);
      break;
    }
  }
}

function scheduleSessionDelivery(sid: string, tty: string, transcriptPath: string, pid: number): void {
  if (activeDeliveries.has(sid)) return;
  activeDeliveries.add(sid);
  void drainSessionDelivery(sid, tty, transcriptPath, pid).finally(() => activeDeliveries.delete(sid));
}

async function drainSessionDelivery(sid: string, tty: string, transcriptPath: string, pid: number): Promise<void> {
  const pending = getSessionPending(sid);
  if (!pending.length) return;

  const result = await deliverMessagesSequentially(pending, {
    getState: () => {
      const state = detectState(transcriptPath);
      return state === "gone" && isProcessAlive(pid) ? "waiting" : state;
    },
    send: (message) => sendViaITerm(tty, message),
    markDelivered,
    onDelivered: async (item) => {
      await replyCard(item.id, "✅ 已自动发送", `任务完成后消息已自动发送到 Claude Code 终端。\n\n> ${item.content.slice(0, 200)}`, "green", sid);
    },
    sleep,
  });

  log(`📬 [${sid.slice(0, 16)}] 队列投递: sent=${result.sent} remaining=${result.remaining} reason=${result.reason}`);
}

function makeSessionMsg(id: string, chatId: string, sender: string, content: string, sessionId: string): QueuedMessage {
  return {
    id,
    chat_id: chatId,
    sender,
    content,
    session_id: sessionId,
    received_at: new Date().toISOString(),
    status: "pending",
  };
}

export async function pollLoop(): Promise<number> {
  log(`🚀 监听启动 (间隔 ${config.pollInterval}s)`);
  let errors = 0;
  while (running) {
    try {
      const ids = await processNewMessages();
      if (ids.length) log(`✓ ${ids.length} 条, 待处理: ${pendingCount()}`);
      errors = 0;
    } catch (e) {
      errors++;
      log(`异常(${errors}): ${e}`, "ERROR");
      if (errors > 10) {
        log("暂停 30s", "WARN");
        await sleep(30_000);
        errors = 0;
      }
    }
    await sleep(config.pollInterval * 1000);
  }
  log("监听已停止");
  return 0;
}

export async function runOnce(): Promise<void> {
  const ids = await processNewMessages();
  console.log(`处理 ${ids.length} 条新消息`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
