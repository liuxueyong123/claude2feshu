/**
 * notifyd — claude2feishu HTTP 通知服务
 *
 * 常驻 Koa HTTP 服务，接收 Claude Code hooks 通过 curl POST 发来的事件，
 * 统一处理通知、session 管理、消息投递。
 *
 * 用法:
 *   pnpm service-start     # 后台启动
 *   pnpm service-stop      # 停止
 *   pnpm service-status    # 状态检查
 *
 * 接口:
 *   POST /hook             # 接收 hook 事件 JSON (?title=&type=&include-bash-errors)
 *   GET  /health           # 健康检查
 *   GET  /inbox            # 查看待处理指令
 *   POST /inbox/pop        # 弹出下一条指令
 */
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config, DATA_DIR } from "./config.js";
import { log } from "./logger.js";
import {
  processHookEvent,
  checkInboxText,
  popInboxCommand,
} from "./notify.js";
import type { HookEvent } from "./notify.js";

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.FEISHU_NOTIFYD_PORT ?? "9876", 10);
const HOST = process.env.FEISHU_NOTIFYD_HOST ?? "127.0.0.1";
const PID_FILE = resolve(DATA_DIR, "notifyd.pid");
const startedAt = Date.now();

// ═══════════════════════════════════════════════════════════════
// PID 文件
// ═══════════════════════════════════════════════════════════════

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

// Body parser: 自动解析 JSON → ctx.request.body
app.use(bodyParser({ enableTypes: ["json"] }));

// 全局错误处理
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    log(`请求异常: ${e}`, "ERROR");
    ctx.status = 500;
    ctx.body = { error: "internal error" };
  }
});

// POST /hook — 接收 hook 事件
app.use(async (ctx, next) => {
  if (ctx.method !== "POST" || ctx.path !== "/hook") return next();

  const body = ctx.request.body as Record<string, unknown> | undefined;
  if (!body || Object.keys(body).length === 0) {
    ctx.status = 400;
    ctx.body = { error: "empty body" };
    return;
  }

  const event = body as unknown as HookEvent;
  const title = (ctx.query.title as string) ?? "Claude Code";
  const message = (ctx.query.message as string) ?? "";
  const type = (ctx.query.type as string) ?? "info";
  const includeBashErrors = "include-bash-errors" in ctx.query;

  log(
    `hook: ${event.hook_event_name ?? "unknown"} session=${(event.session_id ?? "").slice(0, 16)}`,
    "DEBUG",
  );

  await processHookEvent(event, title, message, type, { includeBashErrors });
  ctx.body = { ok: true };
});

// GET /health — 健康检查
app.use((ctx, next) => {
  if (ctx.method !== "GET" || ctx.path !== "/health") return next();
  ctx.body = {
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    port: PORT,
  };
});

// GET /inbox — 查看待处理指令
app.use((ctx, next) => {
  if (ctx.method !== "GET" || ctx.path !== "/inbox") return next();
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = checkInboxText();
});

// POST /inbox/pop — 弹出下一条指令
app.use((ctx, next) => {
  if (ctx.method !== "POST" || ctx.path !== "/inbox/pop") return next();
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = popInboxCommand();
});

// ═══════════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════════

const server = app.listen(PORT, HOST, () => {
  writePid();
  log(`notifyd 启动: http://${HOST}:${PORT} pid=${process.pid}`, "INFO");
  if (!config.appId || !config.appSecret) {
    log("缺少 FEISHU_APP_ID/SECRET，飞书通知将无法发送", "WARN");
  }
});

// 优雅退出
const shutdown = (signal: string) => {
  log(`收到 ${signal}，正在退出...`, "INFO");
  removePid();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
