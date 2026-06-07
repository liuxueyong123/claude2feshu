/** 飞书消息轮询守护进程 — 后台拉取 @消息写入 inbox */
import { config } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { storage } from "../utils/storage.js";
import { listReceivedMessages, extractText, replyCard, getQuotedMessageId, lookupCardSession } from "../feishu/api.js";
import { enqueue, pendingCount } from "../session/queue.js";
import type { QueuedMessage } from "../utils/storage.js";
import { detectState, sendToTerminal } from "../utils/terminal.js";
import { getSession, findByPrefix, listActive, isProcessAlive, drainDeadSessions } from "../session/state.js";
import { sendNotification as notifyCard } from "../notify/index.js";
import { recordDelivery } from "../session/delivery.js";

let running = false;
let polling = false;

export function stopPolling(): void {
  running = false;
}

export function startPolling(): void {
  if (polling) return;
  running = true;
  polling = true;
  pollLoop()
    .catch((e) => log(`pollLoop 异常: ${e}`, "ERROR"))
    .finally(() => {
      polling = false;
    });
}

export function isPolling(): boolean {
  return polling;
}

async function processNewMessages(): Promise<string[]> {
  const lastId = storage.lastMsgId;
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
    if (!text) continue;
    log(`📨 [${sender}] ${text.slice(0, 80)}`);

    // ---- 诊断：保存原始消息（引用/回复消息时） ----
    const rawParent = (msg as unknown as Record<string, unknown>).parent_id as string | undefined;
    const rawRoot = (msg as unknown as Record<string, unknown>).root_id as string | undefined;
    if (rawParent || rawRoot) {
      log(`引用消息: msg=${msg.message_id} parent=${rawParent ?? ""} root=${rawRoot ?? ""}`, "DEBUG");
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
        log(`  查找到 session: ${sid}`);
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

    // 通用 inbox（无 session 绑定）
    enqueue({
      id,
      chat_id: chatId,
      sender,
      content: text.trim(),
      received_at: msg.create_time,
      status: "pending",
    });
    const fallbackReply = buildInboxFallbackReply(text);
    await replyCard(id, fallbackReply.title, fallbackReply.content, fallbackReply.color);
  }
  const top = newMsgs[0];
  if (top) {
    storage.lastMsgId = top.message_id;
    storage.lastMsgTime = top.create_time;
  }
  return newMsgs.map((m) => m.message_id);
}

export function buildInboxFallbackReply(text: string): { title: string; content: string; color: string } {
  return {
    title: "📨 已收到，等待投递",
    content: `指令：${text.slice(0, 200)}\n\n` + "当前没有运行中的 Claude Code，指令已存入收件箱。\n" + "下次启动后自动处理。",
    color: "yellow",
  };
}

// ---- Session 路由处理 ----

async function handleSessionMessage(msgId: string, chatId: string, sender: string, text: string, sid: string): Promise<void> {
  log(`🔗 Session 路由: ${sid}`);

  const session = getSession(sid) ?? findByPrefix(sid);
  if (!session) {
    log(`  Session 未注册，入队等待`);
    enqueue(makeSessionMsg(msgId, chatId, sender, text, sid));
    await replyCard(msgId, "📨 已入队", `目标会话未运行，指令已保存。\n\n会话恢复后自动投递。`, "yellow", sid);
    return;
  }

  if (!session.transcript_path) {
    enqueue(makeSessionMsg(msgId, chatId, sender, text, sid));
    await replyCard(msgId, "📨 已入队", `会话状态未知，指令已保存。\n\n确认终端可用后自动投递。`, "yellow", sid);
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
      const ok = sendToTerminal(session.tty, text);
      if (ok) {
        await replyCard(msgId, "✅ 已投递", `指令已发送到终端处理。\n\n> ${text.slice(0, 200)}`, "green", sid);
        recordDelivery(sid, msgId);
        log(`  ✅ 已发送`);
      } else {
        enqueue(makeSessionMsg(msgId, chatId, sender, text, sid));
        await replyCard(msgId, "⚠️ 投递失败", "无法写入终端，指令已保存。\n\n请确认终端软件正在运行。", "yellow", sid);
      }
      break;
    }
    case "busy": {
      enqueue(makeSessionMsg(msgId, chatId, sender, text, sid));
      await replyCard(msgId, "⏳ 处理中，已排队", `当前任务执行中，指令已保存。\n\n任务完成后自动投递。`, "yellow", sid);
      log(`  入队等待 (busy → waiting 时自动发送)`);
      break;
    }
    case "gone": {
      enqueue(makeSessionMsg(msgId, chatId, sender, text, sid));
      await replyCard(msgId, "📨 已入队", `会话已退出，指令已保存。\n\n下次启动后自动投递。`, "yellow", sid);
      log(`  进程已退出，入队`);
      break;
    }
  }
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

/** 检测进程已死但 session 仍为 active 的 session（窗口关闭/SIGHUP），补发通知 */
async function checkDeadSessions(): Promise<void> {
  const dead = drainDeadSessions();
  for (const s of dead) {
    log(`检测到死 session: ${s.session_id.slice(0, 16)}... pid=${s.pid}`, "WARN");
    await notifyCard(
      "Claude 会话已终止",
      `会话 ${s.session_id.slice(0, 8)}… 进程已退出。\n\n可能原因：终端窗口关闭或进程被终止。`,
      "warning",
      s.session_id,
    );
  }
}

export async function pollLoop(): Promise<number> {
  log(`🚀 监听启动 (间隔 ${config.pollInterval}s)`);
  let errors = 0;
  while (running) {
    try {
      const ids = await processNewMessages();
      if (ids.length) log(`✓ ${ids.length} 条, 待处理: ${pendingCount()}`);
      await checkDeadSessions();
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
