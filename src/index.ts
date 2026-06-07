/**
 * claude2feishu 统一服务入口
 *
 * 用法: pnpm start / stop / status / logs
 */
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { writeFileSync, unlinkSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { startPolling, stopPolling, isPolling } from "./bot/index.js";
import { pendingCount } from "./session/queue.js";
import { router as botRouter } from "./bot/routes.js";
import { router as notifyRouter } from "./notify/routes.js";
import { router as sessionRouter } from "./session/routes.js";
import { router as feishuRouter } from "./feishu/routes.js";

const startedAt = Date.now();

function writePid(): void { writeFileSync(config.pidFile, String(process.pid), "utf-8"); }
function removePid(): void { try { unlinkSync(config.pidFile); } catch { /* ignore */ } }

const app = new Koa();
app.use(bodyParser({ enableTypes: ["json"] }));
app.use(async (ctx, next) => {
  try { await next(); } catch (e) { log(`请求异常: ${e}`, "ERROR"); ctx.status = 500; ctx.body = { error: "internal error" }; }
});

// 挂载路由
app.use(botRouter.routes());
app.use(notifyRouter.routes());
app.use(sessionRouter.routes());
app.use(feishuRouter.routes());

// /health
app.use((ctx, next) => {
  if (ctx.path !== "/health") return next();
  ctx.body = { ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000), pid: process.pid, port: config.port, bot: isPolling() ? "polling" : "stopped", pending: pendingCount() };
});

const server = app.listen(config.port, config.host, () => {
  writePid();
  log(`服务启动: http://${config.host}:${config.port} pid=${process.pid}`, "INFO");
  if (!config.appId || !config.appSecret) log("缺少 FEISHU_APP_ID/SECRET", "WARN");
  startPolling();
});

const shutdown = (signal: string) => {
  log(`收到 ${signal}，退出...`, "INFO");
  stopPolling(); removePid();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
