/**
 * Claude Code → 飞书通知
 * 解析 hook stdin JSON，提取丰富上下文，推送卡片到飞书群。
 */
import { sendChatCard, replyCard } from "./feishu_api.js";
import { getPending, popNext, markDone } from "./inbox.js";
import { log } from "./logger.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { execSync } from "node:child_process";
import { hostname } from "node:os";

// ============================================================
// 类型
// ============================================================

interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  question?: string;
  output?: string;
  message?: string;
  response?: string;
  [key: string]: unknown;
}

// ============================================================
// stdin 读取
// ============================================================

function readHookStdin(): HookEvent {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(process.stdin.fd, "utf-8");
    return raw.trim() ? (JSON.parse(raw) as HookEvent) : {};
  } catch {
    return {};
  }
}

// ============================================================
// 上下文构建 — 核心：把 hook 数据变成可读的飞书消息
// ============================================================

const COLORS: Record<string, string> = {
  success: "green",
  warning: "yellow",
  error: "red",
  info: "blue",
};

function buildContext(event: HookEvent): string {
  const lines: string[] = [];
  const name = event.hook_event_name ?? "";

  // ============================================================
  // 基础信息（所有事件都展示）
  // ============================================================

  // 项目 + Git
  if (event.cwd) {
    const project = basename(event.cwd);
    const git = getGitContext(event.cwd);
    lines.push(`📁 **项目：** ${project}`);
    if (git) {
      lines.push(`🌿 **分支：** ${git}`);
    }
  }

  // 主机（macOS 用友好名称，其他平台用 os.hostname()）
  const host = getHostname();
  if (host) lines.push(`💻 **主机：** ${host}`);

  // 模型（从 transcript 中提取 assistant 消息的 model 字段）
  const model = getModel(event);
  if (model) {
    lines.push(`🧠 **模型：** ${model}`);
  }

  // 会话 ID
  const sid = event.session_id ?? "";
  if (sid) {
    lines.push(`🔗 **会话：** \`${sid}\``);
  }

  // ============================================================
  // 事件详情
  // ============================================================

  switch (name) {
    case "SessionStart":
      // 基础信息已够
      break;

    case "Stop": {
      // 会话正常结束时展示最终输出，方便了解完成状态
      const output = getModelOutput(event);
      if (output) {
        lines.push(`💬 **模型输出：** ${output}`);
      }
      break;
    }

    case "StopFailure": {
      const err = event.error ?? "";
      if (err) lines.push(`\n💥 **错误原因**\n\`\`\`\n${clip(err, 500)}\n\`\`\``);
      break;
    }

    case "PermissionRequest": {
      const tool = event.tool_name ?? "未知";
      const input = event.tool_input ?? {};
      lines.push(`\n🛠 **请求操作：** ${toolLabel(tool)}`);
      const desc = describeToolInput(tool, input);
      if (desc) lines.push(`\`\`\`\n${clip(desc, 300)}\n\`\`\``);
      // 展示模型输出，帮助理解 Claude 为什么请求此操作
      const output = getModelOutput(event);
      if (output) {
        lines.push(`💬 **模型输出：** ${output}`);
      }
      break;
    }

    case "PermissionDenied": {
      const tool = event.tool_name ?? "未知";
      lines.push(`\n🚫 **被拒绝：** ${toolLabel(tool)}`);
      const input = event.tool_input ?? {};
      const desc = describeToolInput(tool, input);
      if (desc) lines.push(`\`\`\`\n${clip(desc, 200)}\n\`\`\``);
      break;
    }

    case "Elicitation": {
      const q = event.question ?? "";
      if (q) lines.push(`\n❓ **Claude 的提问**\n\`\`\`\n${clip(q, 400)}\n\`\`\``);
      break;
    }

    case "PostToolUseFailure": {
      const tool = event.tool_name ?? "未知";
      const input = event.tool_input ?? {};
      const err = event.error ?? "";
      lines.push(`\n🔧 **失败操作：** ${toolLabel(tool)}`);
      const desc = describeToolInput(tool, input);
      if (desc) lines.push(`\`\`\`\n${clip(desc, 300)}\n\`\`\``);
      if (err) lines.push(`💥 **错误信息**\n\`\`\`\n${clip(err, 500)}\n\`\`\``);
      break;
    }
  }

  return lines.length ? "\n\n" + lines.join("\n") : "";
}

function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    Bash: "执行 Shell 命令",
    Write: "写入文件",
    Edit: "编辑文件",
    Read: "读取文件",
    WebFetch: "访问网页",
    WebSearch: "搜索网页",
    Grep: "搜索代码",
    Glob: "查找文件",
    Task: "创建任务",
    Agent: "启动子 Agent",
    AskUserQuestion: "向用户提问",
  };
  return map[tool] ?? tool;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * 获取主机名。macOS 优先使用友好名称（如 "lxy的MacBook Pro"），
 * 其他平台使用 os.hostname()。
 */
function getHostname(): string {
  if (process.platform === "darwin") {
    try {
      const name = execSync("scutil --get ComputerName", { encoding: "utf-8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      /* fall through */
    }
  }
  return hostname();
}

function getGitContext(cwd: string): string {
  try {
    if (!cwd || !existsSync(resolve(cwd, ".git"))) return "";
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    const commit = execSync("git log -1 --format=%h", { cwd, encoding: "utf-8", timeout: 3000 }).trim();
    return `${branch}  ${commit}`;
  } catch {
    return "";
  }
}

/**
 * 从 transcript 文件提取模型名称。
 * 查找最新一条 assistant 消息的 model 字段。
 */
function getModel(event: HookEvent): string {
  const tp = event.transcript_path ?? "";
  if (!tp || !existsSync(tp)) return "";

  try {
    const raw = readFileSync(tp, "utf-8");
    const lines = raw.trim().split("\n");
    // 从后往前找 assistant 消息
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg = obj?.message;
        if (msg?.role === "assistant" && msg.model) {
          return msg.model as string;
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* ignore */
  }

  return "";
}

/**
 * 提取模型最近的输出内容。
 * 优先读 transcript 文件最后几行，fallback 到 hook 事件的 output/message 字段。
 */
function getModelOutput(event: HookEvent): string {
  const tp = event.transcript_path ?? "";
  if (!tp || !existsSync(tp)) {
    const out = event.output ?? event.message ?? event.response ?? "";
    if (typeof out === "string" && out.trim()) {
      const cleaned = out
        .split("\n")
        .filter((l) => l.trim())
        .join("\n");
      return clip(cleaned, 200);
    }
    return "";
  }

  try {
    const raw = readFileSync(tp, "utf-8");
    const lines = raw.trim().split("\n");
    // 从后往前找 assistant 消息的 text content
    const texts: string[] = [];
    for (let i = lines.length - 1; i >= 0 && texts.length < 3; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg = obj?.message;
        if (!msg || msg.role !== "assistant") continue;
        for (const c of msg.content ?? []) {
          if (c.type === "text" && c.text) {
            texts.unshift(c.text as string);
          }
        }
      } catch {
        /* skip malformed */
      }
    }
    if (texts.length > 0) {
      const cleaned = texts[texts.length - 1]
        .split("\n")
        .filter((l) => l.trim())
        .join("\n");
      return clip(cleaned, 200);
    }
  } catch {
    /* ignore */
  }

  return "";
}

/**
 * 把工具参数转成人类可读的摘要。
 */
function describeToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash": {
      const cmd = input.command ?? input.cmd ?? "";
      if (typeof cmd === "string") {
        const short = cmd.length > 150 ? cmd.slice(0, 150) + "…" : cmd;
        return short;
      }
      return "";
    }
    case "Write":
    case "Edit": {
      const fp = input.file_path ?? input.filePath ?? "";
      if (typeof fp === "string") {
        return basename(fp as string);
      }
      return "";
    }
    case "WebFetch": {
      const url = input.url ?? "";
      if (typeof url === "string") {
        try {
          return new URL(url as string).hostname;
        } catch {
          return (url as string).slice(0, 60);
        }
      }
      return "";
    }
    case "WebSearch": {
      const q = input.query ?? "";
      if (typeof q === "string") {
        return (q as string).slice(0, 100);
      }
      return "";
    }
    case "Read": {
      const fp = input.file_path ?? input.filePath ?? "";
      if (typeof fp === "string") {
        return basename(fp as string);
      }
      return "";
    }
    default: {
      // 通用：列出所有 key
      const keys = Object.keys(input);
      if (keys.length <= 3) {
        return keys
          .map((k) => {
            const v = JSON.stringify(input[k]);
            return `**${k}**=${v.length > 60 ? v.slice(0, 60) + "…" : v}`;
          })
          .join(", ");
      }
      return `${keys.length} 个参数`;
    }
  }
}

// ============================================================
// 公开 API
// ============================================================

export function sendNotification(title: string, message: string, type = "info"): Promise<boolean> {
  return sendChatCard(title, message, COLORS[type] ?? "blue");
}

export function replyToMessage(msgId: string, text: string): Promise<boolean> {
  return replyCard(msgId, "✅ Claude Code 执行结果", `${text}\n\n— Claude Code`, "green");
}

export function checkInboxText(): string {
  const p = getPending();
  return p.length ? p.map((c) => `[${c.sender}] ${c.content} (ID: ${c.id})`).join("\n") : "📭 无待处理指令";
}

export function popInboxCommand(): string {
  const cmd = popNext();
  return cmd ? `[Feishu指令] 来自 ${cmd.sender}: ${cmd.content}\n(ID: ${cmd.id})` : "📭 无待处理指令";
}

// ============================================================
// CLI 入口
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const g = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const h = (f: string) => args.includes(f);

  // 非通知模式
  if (h("--check-inbox")) {
    console.log(checkInboxText());
    return;
  }
  if (h("--pop")) {
    console.log(popInboxCommand());
    return;
  }
  const replyId = g("--reply-to");
  if (replyId) {
    const msg = g("--message") ?? "";
    console.log((await replyToMessage(replyId, msg)) ? `✅ 已回复 ${replyId}` : `❌ 回复失败`);
    markDone(replyId);
    return;
  }

  // ---- 通知模式 ----
  const title = g("--title") ?? "Claude Code";
  const message = g("--message") ?? "";
  const type = g("--type") ?? "info";
  const event = readHookStdin();

  // 诊断：保存完整 hook JSON 到文件，方便后续分析所有可用字段
  if (event.hook_event_name) {
    try {
      appendFileSync(
        resolve(process.env.HOME ?? "/tmp", ".claude", "hook_dump.jsonl"),
        JSON.stringify({
          _ts: new Date().toISOString(),
          _event: event.hook_event_name,
          _keys: Object.keys(event).sort(),
          ...event,
        }) + "\n",
      );
    } catch {
      /* ignore */
    }
  }

  // 拼接上下文
  const ctx = buildContext(event);
  const fullMessage = message + ctx;

  await sendNotification(title, fullMessage, type);

  // SessionStart 额外检查 inbox
  if (event.hook_event_name === "SessionStart") {
    const p = getPending();
    if (p.length) {
      await sendNotification(
        "📥 飞书待处理指令",
        `${p.length} 条\n` +
          p
            .slice(-3)
            .map((c) => `- [${c.sender}]: ${c.content.slice(0, 100)}`)
            .join("\n"),
        "warning",
      );
    }
  }
}

main().catch((e) => {
  log(`notify 异常: ${e}`, "ERROR");
  process.exit(1);
});
