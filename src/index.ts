/**
 * claude2feishu 统一服务入口
 *
 * Koa HTTP 服务，管理所有功能：
 *   - Claude Code hook 事件处理（通知推送）
 *   - feishu_bot 守护进程生命周期
 *   - inbox / session 管理
 *
 * 用法:
 *   pnpm start            # 后台启动（nohup）
 *   pnpm stop             # 停止
 *   pnpm status           # 健康检查
 *   pnpm logs             # 查看日志
 */
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, config } from "./config.js";
import { log } from "./logger.js";
import { processHookEvent, checkInboxText, popInboxCommand } from "./notify.js";
import type { HookEvent } from "./notify.js";
import {
  startPolling,
  stopPolling,
  isPolling,
  runOnce,
} from "./feishu_bot.js";
import {
  getInboxPending,
  getPending,
  pendingCount,
  clearDelivered,
  markDelivered,
  listPendingSessions,
} from "./message_queue.js";
import { replyCard, sendChatCard, listReceivedMessages } from "./feishu_api.js";
import { listActive, getSession } from "./session_state.js";
import { detectState, sendToTerminal } from "./terminal.js";

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.FEISHU_NOTIFYD_PORT ?? "9876", 10);
const HOST = process.env.FEISHU_NOTIFYD_HOST ?? "127.0.0.1";
const PID_FILE = resolve(DATA_DIR, "service.pid");
const startedAt = Date.now();

function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

function removePid(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// Koa App
// ═══════════════════════════════════════════════════════════════

const app = new Koa();
const router = new Router();

app.use(bodyParser({ enableTypes: ["json"] }));
app.use(async (ctx, next) => {
  try { await next(); } catch (e) {
    log(`请求异常: ${e}`, "ERROR");
    ctx.status = 500;
    ctx.body = { error: "internal error" };
  }
});

// ── Hook ──────────────────────────────────────────────────────

router.post("/hook", async (ctx) => {
  const body = ctx.request.body as Record<string, unknown> | undefined;
  if (!body || Object.keys(body).length === 0) {
    ctx.status = 400; ctx.body = { error: "empty body" }; return;
  }
  const event = body as unknown as HookEvent;
  const title = (ctx.query.title as string) ?? "Claude Code";
  const message = (ctx.query.message as string) ?? "";
  const type = (ctx.query.type as string) ?? "info";
  const includeBashErrors = "include-bash-errors" in ctx.query;
  log(`hook: ${event.hook_event_name ?? "unknown"} session=${(event.session_id ?? "").slice(0, 16)}`, "DEBUG");
  await processHookEvent(event, title, message, type, { includeBashErrors });
  ctx.body = { ok: true };
});

// ── Health ────────────────────────────────────────────────────

router.get("/health", (ctx) => {
  ctx.body = {
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    port: PORT,
    bot: isPolling() ? "polling" : "stopped",
    pending: pendingCount(),
  };
});

// ── Daemon ────────────────────────────────────────────────────

router.post("/daemon/start", (ctx) => {
  if (isPolling()) { ctx.body = { ok: true, message: "already running" }; return; }
  startPolling();
  log("bot 轮询已启动", "INFO");
  ctx.body = { ok: true };
});

router.post("/daemon/stop", (ctx) => {
  stopPolling();
  log("bot 轮询已停止", "INFO");
  ctx.body = { ok: true };
});

router.get("/daemon/status", (ctx) => {
  ctx.body = { polling: isPolling(), pending: pendingCount() };
});

router.post("/daemon/once", async (ctx) => {
  await runOnce();
  ctx.body = { ok: true };
});

// ── Inbox ─────────────────────────────────────────────────────

router.get("/inbox", (ctx) => {
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = checkInboxText();
});

router.post("/inbox/pop", (ctx) => {
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = popInboxCommand();
});

router.post("/inbox/done/:id", (ctx) => {
  markDelivered(ctx.params.id);
  ctx.body = { ok: true };
});

router.post("/inbox/reply", async (ctx) => {
  const { msgId, text } = (ctx.request.body as Record<string, string>) ?? {};
  if (!msgId || !text) { ctx.status = 400; ctx.body = { error: "msgId and text required" }; return; }
  const escaped = text.replace(/```/g, "``​`");
  const ok = await replyCard(msgId, "✅ 结果", `\`\`\`\n${escaped}\n\`\`\`\n\n— Claude Code`, "green");
  if (ok) markDelivered(msgId);
  ctx.body = { ok: !!ok };
});

router.post("/inbox/clear", (ctx) => {
  const n = clearDelivered();
  ctx.body = { ok: true, cleared: n };
});

// ── Sessions ──────────────────────────────────────────────────

router.get("/sessions", (ctx) => {
  const active = listActive();
  const pending = listPendingSessions();
  ctx.body = {
    active: active.map((s) => ({
      id: s.session_id,
      pid: s.pid,
      tty: s.tty,
      status: s.status,
      started: s.started_at,
    })),
    pending: pending.map((p) => ({
      session: p.session_id,
      count: p.count,
    })),
  };
});

router.get("/sessions/:id", (ctx) => {
  const s = getSession(ctx.params.id);
  if (!s) { ctx.status = 404; ctx.body = { error: "session not found" }; return; }
  ctx.body = { ...s, claudeState: detectState(s.transcript_path) };
});

router.get("/sessions/:id/queue", (ctx) => {
  const sq = getPending(ctx.params.id);
  ctx.body = sq.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    received: m.received_at,
    status: m.status,
  }));
});

router.post("/sessions/:id/send", (ctx) => {
  const session = getSession(ctx.params.id);
  if (!session) { ctx.status = 404; ctx.body = { error: "session not found" }; return; }
  const { message } = (ctx.request.body as Record<string, string>) ?? {};
  if (!message) { ctx.status = 400; ctx.body = { error: "message required" }; return; }
  const ok = sendToTerminal(session.tty, message);
  ctx.body = { ok };
});

// ── Test ──────────────────────────────────────────────────────

router.post("/test/webhook", async (ctx) => {
  const ok = await sendChatCard("🧪 测试", "webhook 正常 ✅");
  ctx.body = { ok: !!ok };
});

router.post("/test/api", async (ctx) => {
  const msgs = await listReceivedMessages(5, false);
  ctx.body = msgs.map((m) => ({
    type: m.msg_type,
    sender: m.sender?.id,
    content: m.body?.content?.slice(0, 100),
  }));
});

// ═══════════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════════

app.use(router.routes());
app.use(router.allowedMethods());

const server = app.listen(PORT, HOST, () => {
  writePid();
  log(`服务启动: http://${HOST}:${PORT} pid=${process.pid}`, "INFO");
  if (!config.appId || !config.appSecret) {
    log("缺少 FEISHU_APP_ID/SECRET，飞书通知将无法发送", "WARN");
  }
  startPolling();
  log("bot 轮询已自动启动", "INFO");
});

const shutdown = (signal: string) => {
  log(`收到 ${signal}，正在退出...`, "INFO");
  stopPolling();
  removePid();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
