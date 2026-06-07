#!/usr/bin/env npx tsx
/** 飞书 Bot 统一 CLI — 守护进程 + inbox + 通知 */
import { pollLoop, runOnce, writePid, removePid, isRunning } from "./feishu_bot.js";
import { getInboxPending, getPending, pendingCount, clearDelivered, markDelivered } from "./message_queue.js";
import { replyCard, sendChatCard, listReceivedMessages } from "./feishu_api.js";
import { existsSync, readFileSync, openSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PID_FILE, CHECKPOINT_FILE, LOG_FILE } from "./config.js";
import { log } from "./logger.js";
import { listActive, getSession } from "./session_state.js";
import { listPendingSessions } from "./message_queue.js";
import { detectState, sendToTerminal } from "./terminal.js";

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

Session 管理:
  session-list               查看活跃 session + 待处理消息
  session-state <sid>        查看 session 详情 + Claude 状态
  session-queue <sid>        查看 session 待投递消息
  session-send <sid> <msg>   手动发送消息到终端（调试）
`;

async function daemonSpawn() {
  // 确保日志目录存在
  const logDir = LOG_FILE.replace(/\/[^/]+$/, "");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["--import", "tsx", __filename, "daemon"], {
    detached: true, stdio: ["ignore", logFd, logFd], cwd: process.cwd(),
  });
  child.unref();
  console.log(`✅ 守护进程已启动 (PID: ${child.pid})`);
  await sleep(1500);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const a3 = process.argv[3], a4 = process.argv[4];

  switch (cmd) {
    case "start": isRunning() ? console.log("⚠️ 守护进程已在运行") : await daemonSpawn(); break;
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
      const p = getInboxPending();
      console.log(p.length ? p.map(c => `[${c.sender}] ${c.content} (${c.id})`).join("\n") : "📭 收件箱为空");
      break;
    }
    case "pop": { const pending = getInboxPending(); const c = pending[0] ?? null; console.log(c ? `[${c.sender}] ${c.content}\n(ID: ${c.id})` : "📭 收件箱为空"); break; }
    case "done": a3 ? (markDelivered(a3), console.log(`✅ ${a3}`)) : console.error("用法: done <id>"); break;
    case "reply":
      if (a3 && a4) { const escaped = a4.replace(/```/g, '``​`'); const ok = await replyCard(a3, "✅ 结果", `\`\`\`\n${escaped}\n\`\`\`\n\n— Claude Code`, "green"); ok ? (markDelivered(a3), console.log("✅")) : console.error("❌"); }
      else console.error("用法: reply <id> <text>"); break;
    case "clear": console.log(`🧹 ${clearDelivered()} 条`); break;
    case "test-webhook": console.log(await sendChatCard("🧪 测试", "webhook 正常 ✅") ? "✅ OK" : "❌ FAIL"); break;
    case "test-api": {
      const msgs = await listReceivedMessages(5, false);
      msgs.forEach(m => console.log(`[${m.msg_type}] ${m.sender?.id}: ${m.body?.content?.slice(0, 100)}`));
      break;
    }
    case "session-list": {
      const active = listActive();
      if (active.length) {
        active.forEach(s => console.log(`[${s.session_id.slice(0, 16)}...] pid=${s.pid} tty=${s.tty} ${s.status} started=${s.started_at.slice(0, 19)}`));
      } else {
        console.log("无活跃 session");
      }
      const pending = listPendingSessions();
      if (pending.length) {
        console.log(`\n待处理消息: ${pending.map(p => `${p.session_id.slice(0, 12)}... (${p.count}条)`).join(", ")}`);
      }
      break;
    }
    case "session-state": {
      if (a3) {
        const s = getSession(a3);
        if (s) {
          console.log(JSON.stringify(s, null, 2));
          const state = detectState(s.transcript_path);
          console.log(`Claude 状态: ${state}`);
        } else {
          console.log("Session 不存在");
        }
      } else {
        console.log("用法: session-state <session_id>");
      }
      break;
    }
    case "session-queue": {
      const sq = a3 ? getPending(a3) : [];
      if (sq.length) {
        sq.forEach(m => console.log(`[${m.sender}] ${m.content}\n  ── received: ${m.received_at.slice(0, 19)} status: ${m.status}`));
      } else {
        console.log(a3 ? `Session ${a3.slice(0, 16)}... 无待处理消息` : "用法: session-queue <session_id>");
      }
      break;
    }
    case "session-send": {
      if (a3 && a4) {
        const session = getSession(a3);
        if (session) {
          const ok = sendToTerminal(session.tty, a4);
          console.log(ok ? `✅ 已发送到 tty=${session.tty}` : "❌ 发送失败");
        } else {
          console.log("Session 不存在");
        }
      } else {
        console.error("用法: session-send <session_id> <message>");
      }
      break;
    }
    default: console.log(USAGE);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
main().catch(e => { log(`CLI: ${e}`, "ERROR"); process.exit(1); });
