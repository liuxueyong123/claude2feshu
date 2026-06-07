/**
 * setup-hooks.ts — 自动配置 Claude Code hooks
 *
 * 将 claude2feishu 的通知 hooks 写入 ~/.claude/settings.json，
 * 自动检测项目路径，智能合并已有配置。
 *
 * 用法:
 *   pnpm setup-hooks          # 交互确认后写入
 *   pnpm setup-hooks --force  # 覆盖已有同名 hook
 *   pnpm setup-hooks --dry-run # 预览不写入
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 常量 ────────────────────────────────────────────────────────

const PROJECT_DIR = process.cwd();
import { config } from "../utils/config.js";
const NOTIFYD_URL = `http://127.0.0.1:${config.port}`;
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

interface HookDef {
  event: string;
  title: string;
  type: string;
  /** 工具名匹配器（正则），仅 PostToolUse* 类事件使用；
   *  空字符串表示匹配所有工具/session 级事件 */
  matcher: string;
}

/**
 * 需要配置的 hook 事件列表，与 README 步骤 3 一致。
 *
 * 注意：PostToolUseFailure 使用正向枚举匹配器，排除 Bash。
 * Bash 命令失败通常是探索性操作（如 ls 不存在路径、git 无变更），
 * Claude 会自行消化并重试，无需推送通知打断用户。
 * 如需接收 Bash 错误通知，手动将 matcher 改为 "" 即可。
 */
const HOOKS: HookDef[] = [
  { event: "SessionStart", title: "🚀 Claude 已启动", type: "info", matcher: "" },
  { event: "Stop", title: "✅ Claude 任务完成", type: "success", matcher: "" },
  { event: "StopFailure", title: "❌ Claude 异常终止", type: "error", matcher: "" },
  { event: "PermissionRequest", title: "🔐 Claude 请求授权", type: "warning", matcher: "" },
  { event: "PermissionDenied", title: "🚫 Claude 授权被拒", type: "error", matcher: "" },
  { event: "Elicitation", title: "💬 Claude 需要回复", type: "warning", matcher: "" },
  { event: "SessionEnd", title: "🏁 Claude 会话结束", type: "info", matcher: "" },
  {
    event: "PostToolUseFailure",
    title: "⚠️ Claude 工具异常",
    type: "error",
    // 排除 Bash：Bash 失败通常是 Claude 探索性操作，会自行消化
    matcher: "Write|Edit|Read|WebFetch|WebSearch|Grep|Glob|Task|Agent|AskUserQuestion",
  },
];

// ── 工具函数 ────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** 检测 hook entry 是否属于 claude2feishu */
function isFeishuHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const obj = entry as Record<string, unknown>;

  // 简单格式: { command: "..." }
  const cmd = typeof obj.command === "string" ? obj.command : "";
  if (cmd.includes("claude2feishu") || cmd.includes("notify.sh") || cmd.includes(NOTIFYD_URL)) return true;

  // 嵌套格式: { hooks: [{ command: "..." }] }
  const subHooks = Array.isArray(obj.hooks) ? obj.hooks : [];
  for (const h of subHooks) {
    if (typeof h === "object" && h !== null) {
      const innerCmd = typeof (h as Record<string, unknown>).command === "string" ? ((h as Record<string, unknown>).command as string) : "";
      if (innerCmd.includes("claude2feishu") || innerCmd.includes("notify.sh") || innerCmd.includes(NOTIFYD_URL)) return true;
    }
  }

  return false;
}

// ── 核心逻辑 ────────────────────────────────────────────────────

interface SettingsFile {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

interface SetupResult {
  event: string;
  action: "added" | "skipped" | "overwritten";
  command: string;
}

interface HookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

function buildCurlCmd(title: string, type: string, opts?: { withProcessInfo?: boolean }): string {
  const params = new URLSearchParams({ title, type });
  const baseUrl = `${NOTIFYD_URL}/hook?${params.toString()}`;
  if (!opts?.withProcessInfo) {
    return `curl -s -X POST "${baseUrl}" --data-binary @- -H 'Content-Type: application/json'`;
  }

  // SessionStart 专用：在 hook 子进程中沿 PPID 链找到 Claude 的 PID/TTY，
  // 作为 query 参数传给 notifyd，确保多 session 时不会重复。
  return [
    `_PID=$$`,
    `_CPID=""`,
    `_CTTY=""`,
    `while [ "$_PID" -gt 1 ]; do`,
    `  _PPID=$(ps -p $_PID -o ppid= 2>/dev/null | tr -d ' ')`,
    `  _CMD=$(ps -p $_PPID -o command= 2>/dev/null)`,
    `  case "$_CMD" in`,
    `    *claude2feishu*|*hook*) ;;`,
    `    *claude*) _CPID="$_PPID"; _CTTY=$(ps -p $_PPID -o tty= 2>/dev/null | tr -d ' '); break ;;`,
    `  esac`,
    `  _PID="$_PPID"`,
    `done`,
    `_EXTRA=""`,
    `[ -n "$_CPID" ] && [ -n "$_CTTY" ] && _EXTRA="&pid=$_CPID&tty=$_CTTY"`,
    `curl -s -X POST "${baseUrl}$_EXTRA" --data-binary @- -H 'Content-Type: application/json'`,
  ].join("\n");
}

function generateHooks(): Record<string, HookEntry[]> {
  const hooks: Record<string, HookEntry[]> = {};

  for (const h of HOOKS) {
    const withProcessInfo = h.event === "SessionStart";
    hooks[h.event] = [
      {
        matcher: h.matcher,
        hooks: [
          {
            type: "command",
            command: buildCurlCmd(h.title, h.type, { withProcessInfo }),
          },
        ],
      },
    ];
  }

  return hooks;
}

function setup(opts: { dryRun: boolean; force: boolean }): SetupResult[] {
  const existing = readJson<SettingsFile>(SETTINGS_PATH, {});
  const mergedHooks: Record<string, unknown[]> = { ...(existing.hooks ?? {}) };
  const newHooks = generateHooks();
  const results: SetupResult[] = [];

  for (const [event, entries] of Object.entries(newHooks)) {
    const existingEntries = mergedHooks[event] ?? [];
    const cmd = entries[0].hooks[0].command;
    const hasFeishuHook = existingEntries.some(isFeishuHook);

    if (hasFeishuHook && !opts.force) {
      results.push({ event, action: "skipped", command: cmd });
      continue;
    }

    if (hasFeishuHook && opts.force) {
      const kept = existingEntries.filter((e) => !isFeishuHook(e));
      mergedHooks[event] = [...kept, ...entries];
      results.push({ event, action: "overwritten", command: cmd });
    } else {
      mergedHooks[event] = [...existingEntries, ...entries];
      results.push({ event, action: "added", command: cmd });
    }
  }

  const merged: SettingsFile = { ...existing, hooks: mergedHooks };

  if (opts.dryRun) {
    console.log("\n📝 预览（--dry-run，未实际写入）:\n");
    console.log(JSON.stringify({ hooks: newHooks }, null, 2));
  } else {
    writeJson(SETTINGS_PATH, merged);
  }

  return results;
}

// ── CLI ─────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  console.log(`\n🔧 claude2feishu Hook 配置工具`);
  console.log(`   通知服务: ${NOTIFYD_URL}`);
  console.log(`   配置文件: ${SETTINGS_PATH}`);

  if (dryRun) console.log(`   模式:     预览（不写入）`);
  if (force) console.log(`   模式:     强制覆盖`);

  const results = setup({ dryRun, force });

  console.log(`\n${dryRun ? "📝 预览" : "✅ 配置"} 结果:\n`);

  const icons: Record<string, string> = {
    added: "🆕",
    skipped: "⏭️",
    overwritten: "🔄",
  };

  for (const r of results) {
    console.log(`   ${icons[r.action]} ${r.event}: ${r.action}`);
  }

  const added = results.filter((r) => r.action === "added").length;
  const overwritten = results.filter((r) => r.action === "overwritten").length;
  const skipped = results.filter((r) => r.action === "skipped").length;

  console.log();
  if (dryRun) {
    console.log(`   共 ${results.length} 个 hook，以上为预览。`);
    console.log(`   执行 pnpm setup-hooks 写入，--force 覆盖已有项。`);
  } else {
    if (skipped > 0) {
      console.log(`   ⚠️  ${skipped} 个 hook 因已存在被跳过。`);
      console.log(`   执行 pnpm setup-hooks --force 可强制覆盖。`);
    }
    if (added + overwritten > 0) {
      console.log(`   ✅ ${added + overwritten} 个 hook 已配置到 ${SETTINGS_PATH}`);
    }
  }
  console.log();
}

main();
