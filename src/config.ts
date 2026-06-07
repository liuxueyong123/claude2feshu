/**
 * 统一配置 — dotenv 加载 .env，所有配置通过 config 对象访问。
 * 外部不应直接读取 process.env，全部通过此模块获取。
 */
import "dotenv/config";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

function loadConfig() {
  const dataDir = process.env.FEISHU_DATA_DIR || resolve(HOME, ".claude", "feishu");

  return {
    // ── 飞书 API ────────────────────────────────────────────
    appId:            process.env.FEISHU_APP_ID     || "",
    appSecret:        process.env.FEISHU_APP_SECRET || "",
    chatId:           process.env.FEISHU_CHAT_ID    || "",

    // ── 服务 ────────────────────────────────────────────────
    port:             parseInt(process.env.FEISHU_NOTIFYD_PORT  || "9876", 10),
    host:             process.env.FEISHU_NOTIFYD_HOST || "127.0.0.1",
    pollInterval:     parseInt(process.env.FEISHU_POLL_INTERVAL || "3", 10),
    logLevel:         process.env.FEISHU_LOG_LEVEL   || "INFO",

    // ── 路径 ────────────────────────────────────────────────
    dataDir,
    checkpointFile:   resolve(dataDir, "feishu_checkpoint.json"),
    pidFile:          resolve(dataDir, "service.pid"),
    logFile:          resolve(dataDir, "service.log"),

    // ── 常量 ────────────────────────────────────────────────
    apiBase:          "https://open.feishu.cn/open-apis",
    tzOffset:         8,
    requestTimeoutMs: 15_000,
  } as const;
}

export const config = loadConfig();
export type AppConfig = typeof config;
