/**
 * Claude Code → 飞书通知
 * 构建 hook 事件上下文，推送卡片到飞书群。
 */
import { sendChatCard, replyCard } from "../feishu/api.js";
import { getInboxPending, getPending as getPendingMessages } from "../session/queue.js";
import { registerSession, markIdle, isProcessAlive, getSession } from "../session/state.js";
import { findMyClaudeProcess, sendToTerminal } from "../utils/terminal.js";
import { getLastDelivery, clearDelivery } from "../session/delivery.js";
import { log } from "../utils/logger.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { execSync } from "node:child_process";
import { hostname } from "node:os";
import { deliverNextPending } from "../session/delivery.js";

// ============================================================
// 类型
// ============================================================

export interface HookEvent {
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
    lines.push(`🔗 **会话 ID：** \`${sid}\``);
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
        lines.push(`\n💬 **模型输出：**\n${wrapInCodeBlock(output)}`);
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
        lines.push(`💬 **模型输出：**\n${wrapInCodeBlock(output)}`);
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

/** 按 UTF-8 字节数安全截断，不切断多字节字符 */
function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
  let result = "";
  for (const ch of s) {
    if (Buffer.byteLength(result + ch, "utf-8") > maxBytes - 3) break; // -3 留给 "…"
    result += ch;
  }
  return result + "…";
}

/** 飞书卡片 JSON 上限 30KB，留出结构开销后内容的保守字节上限 */
const CARD_CONTENT_MAX_BYTES = 24000; // 24KB，留 6KB 给卡片结构 + JSON 转义开销

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
 *
 * 优先级:
 *   1. last_assistant_message — Stop 事件直接携带，最可靠
 *   2. transcript 文件 — 内容最完整（PreToolUse 等事件需要）
 *   3. event.output/message/response — 最后兜底
 */
function getModelOutput(event: HookEvent): string {
  // 1) Stop 事件：Claude Code 直接在事件里带了最后一句话
  const lastMsg = (event as Record<string, unknown>).last_assistant_message;
  if (typeof lastMsg === "string" && lastMsg.trim()) {
    return clipBytes(lastMsg.trim(), 5000);
  }

  // 2) 回退到 transcript（PreToolUse 等事件必须走这里）
  const tp = event.transcript_path ?? "";
  if (tp && existsSync(tp)) {
    try {
      const raw = readFileSync(tp, "utf-8");
      const lines = raw.trim().split("\n");
      // 从后往前找 assistant 消息的 text content（只取最近一条）
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj?.message;
          if (!msg || msg.role !== "assistant") continue;
          const content = msg.content;
          if (typeof content === "string") {
            const result = clipBytes(content.trim(), 5000);
            if (result) return result;
          } else if (Array.isArray(content)) {
            // 取数组里最后一个 text 块（倒序遍历）
            for (let j = content.length - 1; j >= 0; j--) {
              const c = content[j] as Record<string, unknown>;
              if (c.type === "text" && typeof c.text === "string" && (c.text as string).trim()) {
                return clipBytes((c.text as string).trim(), 5000);
              }
            }
          }
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 3) 兜底：event 自带的输出字段
  const out = event.output ?? event.message ?? event.response ?? "";
  if (typeof out === "string" && out.trim()) {
    const cleaned = out.split("\n").filter((l) => l.trim()).join("\n");
    return clipBytes(cleaned, 5000);
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

export function sendNotification(title: string, message: string, type = "info", sessionId = ""): Promise<string> {
  return sendChatCard(title, message, COLORS[type] ?? "blue", sessionId);
}

/** 将文本用代码块包裹，同时转义内部 code fence 避免飞书 markdown 格式错误 */
function wrapInCodeBlock(text: string): string {
  if (!text) return text;
  // 内容中已有的 ``` 用零宽空格断开，避免提前关闭外层代码块
  const escaped = text.replace(/```/g, "``​`");
  return "```\n" + escaped + "\n```";
}

export function replyToMessage(msgId: string, text: string, sessionId = ""): Promise<string> {
  // 按字节截断到卡片上限，保留代码块包裹结构
  const body = wrapInCodeBlock(clipBytes(text, CARD_CONTENT_MAX_BYTES));
  return replyCard(msgId, "✅ 执行结果", `${body}\n\n— Claude Code`, "green", sessionId);
}

export function checkInboxText(): string {
  const p = getInboxPending();
  return p.length ? p.map((c) => `[${c.sender}] ${c.content} (ID: ${c.id})`).join("\n") : "📭 无待处理指令";
}

export function popInboxCommand(): string {
  const pending = getInboxPending();
  const cmd = pending[0] ?? null;
  return cmd ? `[Feishu指令] 来自 ${cmd.sender}: ${cmd.content}\n(ID: ${cmd.id})` : "📭 无待处理指令";
}

// ============================================================
// 后台投递（fire-and-forget，不阻塞 hook 返回）
// ============================================================

async function deliverNextInBackground(pid: number, tty: string, sid: string, transcriptPath: string): Promise<void> {
  const result = await deliverNextPending({
    sessionId: sid,
    tty,
    transcriptPath,
    pid,
    sendToTerminal,
    replyCard,
  });

  const pendingTotal = result.failed + result.remaining;
  if (result.sent > 0 || pendingTotal > 0) {
    await sendNotification(
      `📥 消息投递：${result.sent} 条成功`,
      result.details.slice(-10).join("\n") + (pendingTotal > 0 ? `\n\n⚠️ ${pendingTotal} 条保留在队列中，等待下次 hook 投递` : ""),
      pendingTotal === 0 ? "success" : "warning",
      sid,
    );
    log(`📬 单条投递完成: sent=${result.sent} remaining=${result.remaining} reason=${result.reason}`);
  }
}

// ============================================================
// 核心事件处理（CLI 和 notifyd 共用）
// ============================================================

export interface ProcessHookEventOpts {
  includeBashErrors?: boolean;
  /** 由 hook 命令通过 query 参数传入的 Claude 进程 PID（比全局 ps 搜索更精准） */
  pid?: number;
  /** 由 hook 命令通过 query 参数传入的 Claude 进程 TTY */
  tty?: string;
}

/**
 * 处理 hook 事件：过滤 → 构建上下文 → 发通知 → Session 生命周期管理。
 */
export async function processHookEvent(event: HookEvent, title: string, message: string, type: string, opts: ProcessHookEventOpts = {}): Promise<void> {
  // ---- 通知过滤 ----
  // Bash 工具执行失败通常是 Claude 探索性操作（如 ls 路径不存在、git 无变更），
  // Claude 会自行消化错误并重试，无需推送通知打断用户。
  if (event.hook_event_name === "PostToolUseFailure" && event.tool_name === "Bash" && !opts.includeBashErrors) {
    log(`Bash 错误已过滤: ${(event.error ?? "").slice(0, 120)}`, "DEBUG");
    return;
  }

  // 拼接上下文：先给 ctx 留出空间，剩余字节全给 message
  const ctx = buildContext(event);
  const msgMaxBytes = Math.max(4000, CARD_CONTENT_MAX_BYTES - Buffer.byteLength(ctx, "utf-8"));
  const fullMessage = clipBytes(message, msgMaxBytes) + ctx;

  const sid = event.session_id ?? "";

  // Stop/StopFailure: 尝试引用回复原始飞书消息，形成对话线程
  let notificationSent = false;
  if (sid && (event.hook_event_name === "Stop" || event.hook_event_name === "StopFailure")) {
    const replyMsgId = getLastDelivery(sid);
    if (replyMsgId) {
      const ok = await replyCard(replyMsgId, title, fullMessage, COLORS[type] ?? "blue", sid);
      if (ok) {
        clearDelivery(sid);
        notificationSent = true;
        log(`引用回复: ${replyMsgId.slice(0, 16)}...`, "DEBUG");
      }
    }
  }
  if (!notificationSent) {
    await sendNotification(title, fullMessage, type, sid);
  }

  // ---- Session 生命周期管理 ----

  if (event.hook_event_name === "SessionStart" && sid) {
    // 优先使用 hook 命令通过 query 参数传入的 pid/tty（运行在 Claude 子进程中，更精准），
    // 回退到 findMyClaudeProcess()（兼容旧版 hook 配置）
    let proc: { pid: number; tty: string } | null = null;
    if (opts.pid && opts.tty && !isNaN(opts.pid)) {
      proc = { pid: opts.pid, tty: opts.tty };
    }
    if (!proc) {
      proc = findMyClaudeProcess();
    }
    if (proc) {
      registerSession({
        session_id: sid,
        pid: proc.pid,
        tty: proc.tty,
        transcript_path: event.transcript_path ?? "",
        status: "active",
        started_at: new Date().toISOString(),
        last_heartbeat: "",
      });
      log(`Session 注册: ${sid}... pid=${proc.pid} tty=${proc.tty}`, "DEBUG");
    }

    const p = getInboxPending();
    if (p.length) {
      await sendNotification(
        "📥 收件箱待处理",
        `共 ${p.length} 条指令：\n` +
          p
            .slice(-3)
            .map((c) => `- [${c.sender}]: ${c.content.slice(0, 100)}`)
            .join("\n"),
        "warning",
        sid,
      );
    }

    if (proc) {
      void deliverNextInBackground(proc.pid, proc.tty, sid, event.transcript_path ?? "");
    }
  }

  if (sid && (event.hook_event_name === "Stop" || event.hook_event_name === "StopFailure" || event.hook_event_name === "SessionEnd")) {
    markIdle(sid);
    const session = getSession(sid);
    if (session && isProcessAlive(session.pid)) {
      await deliverNextInBackground(session.pid, session.tty, sid, session.transcript_path || event.transcript_path || "");
    }
    const sq = getPendingMessages(sid);
    if (sq.length) {
      await sendNotification(
        "📬 会话结束，待处理消息",
        `${sq.length} 条指令等待处理：\n` +
          sq
            .slice(-3)
            .map((m) => `- [${m.sender}]: ${m.content.slice(0, 100)}`)
            .join("\n") +
          `\n\n终端空闲时自动投递。`,
        "warning",
        sid,
      );
    }
  }
}
