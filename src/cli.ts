#!/usr/bin/env npx tsx
/** 飞书 Bot 统一 CLI — 守护进程 + inbox + 通知 */
import { pollLoop, runOnce, writePid, removePid, isRunning } from "./feishu_bot.js";
import { getPending, popNext, pendingCount, clearDone, markDone } from "./inbox.js";
import { replyCard, sendChatCard, listReceivedMessages } from "./feishu_api.js";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PID_FILE, CHECKPOINT_FILE } from "./config.js";
import { log } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);

const USAGE = `飞书 Bot 管理

用法: npx tsx src/cli.ts <command>

  start       后台守护进程（监听@消息）
  stop        停止守护进程
  restart     重启
  status      状态 + inbox 统计
  once        单次拉取（测试）
  inbox       待处理指令
  pop         弹出下一条指令
  done <id>   标记完成
  reply <id> <text>  回复并标记完成
  clear       清理已完成记录
  test-webhook 测试 webhook
  test-api     测试 API（拉取消息）
`;

async function daemonSpawn() {
  const child = spawn(process.execPath, ["--import", "tsx", __filename, "daemon"], {
    detached: true, stdio: "ignore", cwd: process.cwd(),
  });
  child.unref();
  console.log(`✅ 守护进程已启动 (PID: ${child.pid})`);
  await sleep(1500);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const a3 = process.argv[3], a4 = process.argv[4];

  switch (cmd) {
    case "start": isRunning() ? console.log("⚠️ 已在运行") : await daemonSpawn(); break;
    case "daemon": writePid(); process.on("exit", removePid); process.on("SIGTERM", () => { removePid(); process.exit(0); }); await pollLoop(); removePid(); break;
    case "stop":
      if (isRunning()) { process.kill(Number(readFileSync(PID_FILE, "utf-8").trim()), "SIGTERM"); console.log("✅ 已停止"); }
      else console.log("ℹ️ 未运行"); break;
    case "restart":
      if (isRunning()) { process.kill(Number(readFileSync(PID_FILE, "utf-8").trim()), "SIGTERM"); await sleep(1000); }
      await daemonSpawn(); break;
    case "status":
      console.log(`守护进程: ${isRunning() ? "✅ 运行中" : "⚠️ 未运行"} | 待处理: ${pendingCount()} 条`);
      if (existsSync(CHECKPOINT_FILE)) console.log(`Checkpoint: ${readFileSync(CHECKPOINT_FILE, "utf-8")}`);
      break;
    case "once": await runOnce(); break;
    case "inbox": {
      const p = getPending();
      console.log(p.length ? p.map(c => `[${c.sender}] ${c.content} (${c.id})`).join("\n") : "📭 无待处理");
      break;
    }
    case "pop": { const c = popNext(); console.log(c ? `[${c.sender}] ${c.content}\n(ID: ${c.id})` : "📭 无"); break; }
    case "done": a3 ? (markDone(a3), console.log(`✅ ${a3}`)) : console.error("用法: done <id>"); break;
    case "reply":
      if (a3 && a4) { const ok = await replyCard(a3, "✅ 结果", `${a4}\n\n— Claude Code`, "green"); ok ? (markDone(a3), console.log("✅")) : console.error("❌"); }
      else console.error("用法: reply <id> <text>"); break;
    case "clear": console.log(`🧹 ${clearDone()} 条`); break;
    case "test-webhook": console.log(await sendChatCard("🧪 测试", "webhook 正常 ✅") ? "✅ OK" : "❌ FAIL"); break;
    case "test-api": {
      const msgs = await listReceivedMessages(5, false);
      msgs.forEach(m => console.log(`[${m.msg_type}] ${m.sender?.id}: ${m.body?.content?.slice(0, 100)}`));
      break;
    }
    default: console.log(USAGE);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main().catch(e => { log(`CLI: ${e}`, "ERROR"); process.exit(1); });
