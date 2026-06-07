import type { Context, Next } from "koa";
import { log } from "./logger.js";

export type RequestLogWriter = (message: string) => void;

export function createRequestLogger(
  write: RequestLogWriter = (message) => log(message, "INFO"),
) {
  return async (ctx: Context, next: Next): Promise<void> => {
    const startedAt = Date.now();
    await next();
    const elapsedMs = Date.now() - startedAt;
    write(`${ctx.method} ${ctx.originalUrl} ${ctx.status} ${elapsedMs}ms ${formatLength(ctx.length)}`);
  };
}

function formatLength(length: number | string | undefined): string {
  if (length === undefined) return "-";
  return `${length}b`;
}
