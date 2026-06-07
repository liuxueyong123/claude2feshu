import type { Server } from "node:http";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { config } from "./utils/config.js";
import { log } from "./utils/logger.js";
import { storage } from "./utils/storage.js";
import { createApp } from "./app.js";
import { startPolling, stopPolling } from "./bot/index.js";

export interface ServiceHandle {
  server: Server;
  shutdown: (signal: string) => void;
}

export function startService(): ServiceHandle {
  storage.load();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    writePid();
    log(`服务启动: http://${config.host}:${config.port} pid=${process.pid}`, "INFO");
    if (!config.appId || !config.appSecret) log("缺少 FEISHU_APP_ID/SECRET", "WARN");
    startPolling();
  });

  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，持久化并退出...`, "INFO");
    stopPolling();
    storage.persist();
    removePid();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };

  return { server, shutdown };
}

function writePid(): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(config.pidFile, String(process.pid), "utf-8");
}

function removePid(): void {
  try {
    unlinkSync(config.pidFile);
  } catch {
    /* ignore */
  }
}
