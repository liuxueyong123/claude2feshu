/**
 * 统一配置 — dotenv 加载 .env，所有配置通过 config 对象访问。
 */
import "dotenv/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadConfig() {
  const dataDir = process.env.FEISHU_DATA_DIR || resolve(PROJECT_ROOT, "data");

  return {
    appId:            process.env.FEISHU_APP_ID     || "",
    appSecret:        process.env.FEISHU_APP_SECRET || "",
    chatId:           process.env.FEISHU_CHAT_ID    || "",
    port:             parseInt(process.env.FEISHU_NOTIFYD_PORT  || "9876", 10),
    host:             process.env.FEISHU_NOTIFYD_HOST || "127.0.0.1",
    pollInterval:     parseInt(process.env.FEISHU_POLL_INTERVAL || "3", 10),
    logLevel:         process.env.FEISHU_LOG_LEVEL   || "INFO",
    dataDir,
    pidFile:          resolve(dataDir, "service.pid"),
    logFile:          resolve(dataDir, "service.log"),
    apiBase:          "https://open.feishu.cn/open-apis",
    tzOffset:         8,
    requestTimeoutMs: 15_000,
  } as const;
}

export const config = loadConfig();
export type AppConfig = typeof config;
