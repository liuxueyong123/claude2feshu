/**
 * notifyd — claude2feishu HTTP 通知服务
 *
 * 常驻 HTTP 服务，接收 Claude Code hooks 通过 curl POST 发来的事件，
 * 统一处理通知、session 管理、消息投递。
 *
 * 用法:
 *   pnpm service-start     # 后台启动
 *   pnpm service-stop      # 停止
 *   pnpm service-status    # 状态检查
 *
 * 接口:
 *   POST /hook             # 接收 hook 事件 JSON
 *   GET  /health           # 健康检查
 *   GET  /inbox            # 查看待处理指令
 *   POST /inbox/pop        # 弹出下一条指令
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
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
// HTTP 工具
// ═══════════════════════════════════════════════════════════════

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data) + "\n");
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

const startedAt = Date.now();

async function handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req).catch(() => "");
  if (!body.trim()) { json(res, 400, { error: "empty body" }); return; }

  let event: HookEvent;
  try { event = JSON.parse(body) as HookEvent; } catch {
    json(res, 400, { error: "invalid JSON" }); return;
  }

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const title = url.searchParams.get("title") ?? "Claude Code";
  const message = url.searchParams.get("message") ?? "";
  const type = url.searchParams.get("type") ?? "info";
  const includeBashErrors = url.searchParams.has("include-bash-errors");

  log(
    `hook: ${event.hook_event_name ?? "unknown"} session=${(event.session_id ?? "").slice(0, 16)}`,
    "DEBUG",
  );

  try {
    await processHookEvent(event, title, message, type, { includeBashErrors });
    json(res, 200, { ok: true });
  } catch (e) {
    log(`processHookEvent 异常: ${e}`, "ERROR");
    json(res, 500, { ok: false, error: String(e) });
  }
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, {
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    port: PORT,
  });
}

function handleInbox(_req: IncomingMessage, res: ServerResponse): void {
  text(res, 200, checkInboxText());
}

function handleInboxPop(_req: IncomingMessage, res: ServerResponse): void {
  text(res, 200, popInboxCommand());
}

// ═══════════════════════════════════════════════════════════════
// 服务启动
// ═══════════════════════════════════════════════════════════════

function main(): void {
  const server = createServer(async (req, res) => {
    const rawUrl = req.url ?? "/";
    // 路由匹配时忽略 query string
    const path = rawUrl.split("?")[0];
    const method = req.method ?? "GET";

    try {
      if (method === "POST" && path === "/hook") {
        await handleHook(req, res);
      } else if (method === "GET" && path === "/health") {
        handleHealth(req, res);
      } else if (method === "GET" && path === "/inbox") {
        handleInbox(req, res);
      } else if (method === "POST" && path === "/inbox/pop") {
        await handleInboxPop(req, res);
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (e) {
      log(`请求处理异常: ${e}`, "ERROR");
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`端口 ${PORT} 已被占用，可能已有 notifyd 在运行`, "ERROR");
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
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
}

main();
