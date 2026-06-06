/** 日志 — stderr 输出，北京时间戳 */
import { TZ_OFFSET } from "./config.js";

function ts(): string {
  const d = new Date();
  const bj = new Date(d.getTime() + d.getTimezoneOffset() * 60_000 + TZ_OFFSET * 3_600_000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${bj.getFullYear()}-${p(bj.getMonth()+1)}-${p(bj.getDate())} ${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
}

const ICONS: Record<string, string> = { DEBUG: "  ", INFO: "📡", WARN: "⚠️", ERROR: "❌" };

export function log(msg: string, level: "DEBUG" | "INFO" | "WARN" | "ERROR" = "INFO") {
  process.stderr.write(`[${ts()}] ${ICONS[level] ?? "  "} ${msg}\n`);
}
