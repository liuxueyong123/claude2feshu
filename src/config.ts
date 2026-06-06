/**
 * 配置加载 — 从 .env 文件和环境变量读取飞书配置
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const HOME = homedir();

// ---- 简易 .env 解析（零依赖） ----

function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* .env 不存在时静默 */ }
  return env;
}

const fileEnv = parseEnvFile(resolve(PROJECT_ROOT, ".env"));

// ---- 配置项 ----

export const config = {
  appId:        process.env.FEISHU_APP_ID     || fileEnv.FEISHU_APP_ID     || "",
  appSecret:    process.env.FEISHU_APP_SECRET || fileEnv.FEISHU_APP_SECRET || "",
  chatId:       process.env.FEISHU_CHAT_ID    || fileEnv.FEISHU_CHAT_ID    || "",
  pollInterval: Number(process.env.FEISHU_POLL_INTERVAL || fileEnv.FEISHU_POLL_INTERVAL || "3"),
  logLevel:     process.env.FEISHU_LOG_LEVEL  || fileEnv.FEISHU_LOG_LEVEL  || "INFO",
} as const;

// ---- 数据路径（运行时数据集中到 ~/.claude/feishu/ 下） ----

export const DATA_DIR = resolve(HOME, ".claude", "feishu");
export const CHECKPOINT_FILE = resolve(DATA_DIR, "feishu_checkpoint.json");
export const PID_FILE = resolve(DATA_DIR, "feishu_bot.pid");
export const LOG_FILE = resolve(DATA_DIR, "feishu_bot.log");

// ---- 常量 ----

export const API_BASE = "https://open.feishu.cn/open-apis";
export const TZ_OFFSET = 8; // 北京时间 UTC+8
export const REQUEST_TIMEOUT_MS = 15_000;
