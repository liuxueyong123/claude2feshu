/**
 * 终端交互 — Claude Code 状态检测 + iTerm2 AppleScript 发送
 *
 * 依赖: macOS + iTerm2 + AppleScript 权限
 * 回退: 检测失败时返回 false，调用方降级为队列模式
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ---- 类型 ----

export type ClaudeState = "waiting" | "busy" | "gone";

interface TranscriptMessage {
  role?: string;
  stop_reason?: string | null;
}

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

// ---- iTerm2 发送 ----

/**
 * 通过 AppleScript 往 iTerm2 的指定 TTY session 发送文本。
 *
 * 原理: 枚举 iTerm2 所有 session，匹配 tty 名称，write text 模拟键盘输入。
 * 返回 true 表示成功发送。
 */
export function sendViaITerm(tty: string, message: string): boolean {
  if (!tty || !message.trim()) return false;

  const escaped = escapeAppleScript(message);

  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) ends with "${tty}" then
          tell s
            write text "${escaped}"
          end tell
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`.trim();

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

// ---- 辅助 ----

function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
}

/** 获取当前终端的 TTY 名称（在 hook 环境中使用） */
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
 * 用于 feishu_bot 定位 Claude Code 进程。
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
