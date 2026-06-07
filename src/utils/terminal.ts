/**
 * 终端交互 — Claude Code 状态检测 + 键盘输入注入
 *
 * 通过 AppleScript 往终端模拟器注入键盘输入：
 *   iTerm2: write text (精准定位 session, 不抢焦点)
 *   Terminal.app: do script in tab (精准定位 tab)
 *
 * 注意: 直接写 PTY slave (/dev/<tty>) 只能向终端显示文本，不能注入 stdin 输入。
 * PTY 的数据方向是 slave→master（输出），键盘方向是 master→slave（输入）。
 *
 * 依赖: macOS + 终端模拟器 AppleScript 权限
 * 回退: 全部失败时返回 false，调用方降级为队列模式
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ---- 类型 ----

export type ClaudeState = "waiting" | "busy" | "gone";

interface TranscriptMessage {
  role?: string;
  stop_reason?: string | null;
}

const TERMINAL_APP_PATH = "/System/Applications/Utilities/Terminal.app";
const ITERM_APP_PATHS = ["/Applications/iTerm.app", "/Applications/iTerm2.app"];

// ---- 状态检测 ----

/**
 * 读 transcript 最后 N 行，判断 Claude Code 当前状态。
 *
 * 规则:
 *   - 最后一条 message 为 assistant + stop_reason="end_turn" → "waiting"
 *   - 最后一条 message 为 assistant + stop_reason="tool_use" → "busy"
 *   - 最后一条 message 为 user 且无对应 assistant 响应 → "busy"
 *   - 文件不存在 / 无法读取 / 无有效 message → "gone"
 */
export function detectState(transcriptPath: string): ClaudeState {
  if (!transcriptPath || !existsSync(transcriptPath)) return "gone";

  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.trim().split("\n");
    if (!lines.length) return "gone";

    // 从后往前找最后一条有效 message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg: TranscriptMessage | undefined = obj?.message;
        if (!msg?.role) continue;

        if (msg.role === "assistant") {
          const stop = msg.stop_reason ?? "";
          if (stop === "end_turn") return "waiting";
          // tool_use, max_tokens, stop_sequence 等都算 busy
          return "busy";
        }

        if (msg.role === "user") {
          // 用户最后一条消息 — 检查时间戳
          const ts = obj?.timestamp ?? "";
          if (ts) {
            const age = Date.now() - new Date(ts).getTime();
            if (age > 300_000) return "gone"; // >5 min, 进程可能已退出
          }
          return "busy";
        }
      } catch {
        /* skip malformed lines */
      }
    }

    return "gone";
  } catch {
    return "gone";
  }
}

// ---- 终端发送 ----

/**
 * 往 Claude Code 所在终端注入键盘输入（文本 + 回车）。
 *
 * 策略（按优先级）:
 *   1. iTerm2: AppleScript write text（精准定位 TTY session，不抢焦点）
 *   2. Terminal.app: AppleScript do script in tab（精准定位 TTY tab）
 *
 * 直接 PTY 写入不可行: 写入 /dev/<tty> slave 的数据流向 master（终端显示），
 * 而非反向注入进程 stdin。参见 pty(4): "anything written on the replica
 * device is presented as input on the primary device".
 *
 * 返回 true 表示成功注入键盘输入。
 */
export function sendToTerminal(tty: string, message: string): boolean {
  if (!tty || !message.trim()) return false;

  const itermApp = findITermApp();
  if (itermApp && runAppleScript(buildITermScript(itermApp, tty, message))) return true;
  if (runAppleScript(buildTerminalAppScript(tty, message))) return true;

  return false;
}

function findITermApp(): string {
  return ITERM_APP_PATHS.find((path) => existsSync(path)) ?? "";
}

function runAppleScript(script: string): boolean {
  try {
    const result = execSync("osascript", {
      input: script,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return result === "ok";
  } catch {
    return false;
  }
}

function buildITermScript(appPath: string, tty: string, message: string): string {
  const escapedAppPath = escapeAppleScript(appPath);
  const escapedTty = escapeAppleScript(tty);
  const escapedMessage = escapeAppleScript(message);

  return `
if application "${escapedAppPath}" is not running then return "not_running"
tell application "${escapedAppPath}"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) ends with "${escapedTty}" then
          tell s
            write text "${escapedMessage}"
          end tell
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`.trim();
}

/**
 * 构建 Terminal.app 精确投递脚本。
 *
 * Terminal.app 的 tab 暴露 tty 属性，可以像 iTerm2 一样按 TTY 定位，
 * 避免 System Events keystroke 把内容打到前台错误窗口。
 */
export function buildTerminalAppScript(tty: string, message: string): string {
  const escapedTty = escapeAppleScript(tty);
  const escapedMessage = escapeAppleScript(message);

  return `
if application "${TERMINAL_APP_PATH}" is not running then return "not_running"
tell application "${TERMINAL_APP_PATH}"
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) ends with "${escapedTty}" then
        do script "${escapedMessage}" in t
        return "ok"
      end if
    end repeat
  end repeat
  return "not_found"
end tell`.trim();
}

/**
 * AppleScript 字符串转义。
 * 换行替换为空格，因为 write text 本身会按回车发送。
 */
function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
}

/** 获取当前终端的 TTY 名称 */
export function detectTTY(): string {
  try {
    const raw = execSync("tty", { encoding: "utf-8", timeout: 1000 }).trim();
    const m = raw.match(/(ttys\d+)/);
    return m ? m[1] : raw.replace("/dev/", "");
  } catch {
    return "";
  }
}

/**
 * 通过 ps 查找 Claude Code 进程的 PID 和 TTY。
 * 通用实现，不依赖特定终端模拟器。
 */
export function findClaudeProcess(): { pid: number; tty: string } | null {
  try {
    const out = execSync(
      `ps -eo pid,tty,command | grep -E "claude( |$)" | grep -v grep | grep -v "claude2feishu" | grep -v "hook" | grep -v "plugin"`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim();

    if (!out) return null;

    const line = out.split("\n")[0]; // 取第一个
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const tty = parts[1]?.replace("?", "") ?? "";
    if (!pid || isNaN(pid) || !tty || tty === "??") return null;

    return { pid, tty };
  } catch {
    return null;
  }
}

/**
 * 从当前进程向上遍历进程树，找到触发 hook 的 Claude Code 进程。
 *
 * 与 findClaudeProcess() 不同，此函数不会错误匹配到其他 Claude 窗口。
 * 原理: hook 作为 Claude Code 的子进程运行，沿着 PPID 链向上查找即可定位。
 *
 * 进程树示意:
 *   Claude Code (ttys002)          ← 目标
 *     └─ sh -c "notify.sh ..."     ← PPID 链经过这里
 *          └─ node notify.ts       ← 当前进程
 */
export function findMyClaudeProcess(): { pid: number; tty: string } | null {
  let currentPid = process.pid;

  for (let i = 0; i < 10; i++) {
    try {
      const ppidStr = execSync(`ps -p ${currentPid} -o ppid=`, {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      const ppid = Number(ppidStr);
      if (!ppid || ppid <= 1) break;

      const cmd = execSync(`ps -p ${ppid} -o command=`, {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();

      // 匹配 Claude 进程（排除本项目、hook、plugin 子进程）
      if (
        /\bclaude\b/.test(cmd) &&
        !cmd.includes("claude2feishu") &&
        !cmd.includes("hook") &&
        !cmd.includes("plugin")
      ) {
        const tty = execSync(`ps -p ${ppid} -o tty=`, {
          encoding: "utf-8",
          timeout: 2000,
        }).trim();
        return { pid: ppid, tty: tty.replace("?", "") };
      }

      currentPid = ppid;
    } catch {
      break;
    }
  }

  // 回退: 进程树遍历失败时，尝试全局搜索
  return findClaudeProcess();
}
