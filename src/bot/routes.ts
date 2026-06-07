import Router from "@koa/router";
import { startPolling, stopPolling, isPolling, runOnce } from "./index.js";
import { pendingCount } from "../session/queue.js";
import { log } from "../utils/logger.js";

const router = new Router();

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

export { router };
