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
const NOTIFY_SCRIPT = path.join(PROJECT_DIR, "notify.sh");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

interface HookDef {
  event: string;
  title: string;
  type: string;
}

/** 需要配置的 hook 事件列表，与 README 步骤 3 一致 */
const HOOKS: HookDef[] = [
  { event: "SessionStart",        title: "Claude 已启动",    type: "info" },
  { event: "Stop",                title: "Claude 任务完成",   type: "success" },
  { event: "StopFailure",         title: "Claude 异常终止",   type: "error" },
  { event: "PermissionRequest",   title: "Claude 等待确认",   type: "warning" },
  { event: "PermissionDenied",    title: "Claude 权限拒绝",   type: "error" },
  { event: "Elicitation",         title: "Claude 等待输入",   type: "warning" },
  { event: "PostToolUseFailure",  title: "Claude 操作失败",   type: "error" },
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

/** 检测 hook entry 是否属于 claude2feishu，支持三种格式：
 *  简单格式: { command: "...notify.sh..." }
 *  嵌套格式: { hooks: [{ command: "...notify.sh..." }] }
 *  matcher 格式: { matcher: "...", hooks: [{ command: "...notify.sh..." }] }
 */
function isFeishuHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const obj = entry as Record<string, unknown>;

  // 简单格式: { command: "..." }
  const cmd = typeof obj.command === "string" ? obj.command : "";
  if (cmd.includes("claude2feishu") || cmd.includes("notify.sh")) return true;

  // 嵌套格式: { hooks: [{ command: "..." }] } 或 { matcher: "...", hooks: [...] }
  const hooks = Array.isArray(obj.hooks) ? obj.hooks : [];
  for (const h of hooks) {
    if (typeof h === "object" && h !== null) {
      const innerCmd = typeof (h as Record<string, unknown>).command === "string"
        ? (h as Record<string, unknown>).command as string
        : "";
      if (innerCmd.includes("claude2feishu") || innerCmd.includes("notify.sh")) return true;
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

function generateHooks(): Record<string, Array<{ command: string }>> {
  const hooks: Record<string, Array<{ command: string }>> = {};

  for (const h of HOOKS) {
    hooks[h.event] = [
      {
        command: `${NOTIFY_SCRIPT} --title '${h.title}' --type ${h.type}`,
      },
    ];
  }

  return hooks;
}

function setup(opts: { dryRun: boolean; force: boolean }): SetupResult[] {
  if (!fs.existsSync(NOTIFY_SCRIPT)) {
    console.error(`❌ 未找到 notify.sh，期望路径: ${NOTIFY_SCRIPT}`);
    process.exit(1);
  }

  const existing = readJson<SettingsFile>(SETTINGS_PATH, {});
  const mergedHooks: Record<string, unknown[]> = { ...(existing.hooks ?? {}) };
  const newHooks = generateHooks();
  const results: SetupResult[] = [];

  for (const [event, entries] of Object.entries(newHooks)) {
    const existingEntries = mergedHooks[event] ?? [];
    const cmd = entries[0].command;
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
  console.log(`   项目路径: ${PROJECT_DIR}`);
  console.log(`   通知脚本: ${NOTIFY_SCRIPT}`);
  console.log(`   配置文件: ${SETTINGS_PATH}`);

  if (dryRun) console.log(`   模式:     预览（不写入）`);
  if (force)  console.log(`   模式:     强制覆盖`);

  const results = setup({ dryRun, force });

  console.log(`\n${dryRun ? "📝 预览" : "✅ 配置"} 结果:\n`);

  const icons: Record<string, string> = {
    added:       "🆕",
    skipped:     "⏭️",
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
