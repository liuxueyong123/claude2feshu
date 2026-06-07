/**
 * claude2feishu 统一服务入口 — 用法: pnpm start / stop / status / logs
 */
import { startService } from "./server.js";

const service = startService();

process.on("SIGTERM", () => service.shutdown("SIGTERM"));
process.on("SIGINT", () => service.shutdown("SIGINT"));
