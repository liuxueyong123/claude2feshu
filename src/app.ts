import Koa from "koa";
import bodyParser from "koa-bodyparser";
import type { Context, Next } from "koa";
import { config } from "./utils/config.js";
import { log } from "./utils/logger.js";
import { createRequestLogger, type RequestLogWriter } from "./utils/request-logger.js";
import { isPolling } from "./bot/index.js";
import { pendingCount } from "./session/queue.js";
import { router as botRouter } from "./bot/routes.js";
import { router as notifyRouter } from "./notify/routes.js";
import { router as sessionRouter } from "./session/routes.js";
import { router as feishuRouter } from "./feishu/routes.js";

export interface AppOptions {
  startedAt?: number;
  logger?: RequestLogWriter;
}

export function createApp(options: AppOptions = {}): Koa {
  const startedAt = options.startedAt ?? Date.now();
  const app = new Koa();

  app.use(createRequestLogger(options.logger));
  app.use(errorHandler);
  app.use(bodyParser({ enableTypes: ["json"] }));

  app.use(botRouter.routes()).use(botRouter.allowedMethods());
  app.use(notifyRouter.routes()).use(notifyRouter.allowedMethods());
  app.use(sessionRouter.routes()).use(sessionRouter.allowedMethods());
  app.use(feishuRouter.routes()).use(feishuRouter.allowedMethods());
  app.use(healthRoute(startedAt));

  return app;
}

async function errorHandler(ctx: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (error) {
    const status = getHttpStatus(error);
    log(`请求异常: ${error}`, status >= 500 ? "ERROR" : "WARN");
    ctx.status = status;
    ctx.body = { error: status === 400 ? "invalid json" : "internal error" };
  }
}

function getHttpStatus(error: unknown): number {
  const status = (error as { status?: unknown; statusCode?: unknown })?.status ??
    (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function healthRoute(startedAt: number) {
  return async (ctx: Context, next: Next): Promise<void> => {
    if (ctx.path !== "/health") {
      await next();
      return;
    }

    ctx.body = {
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      port: config.port,
      bot: isPolling() ? "polling" : "stopped",
      pending: pendingCount(),
    };
  };
}
