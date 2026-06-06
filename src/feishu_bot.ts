/** 飞书消息轮询守护进程 — 后台拉取 @消息写入 inbox */
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { config, PID_FILE, CHECKPOINT_FILE } from "./config.js";
import { log } from "./logger.js";
import { listReceivedMessages, extractText, replyCard } from "./feishu_api.js";
import { enqueueCommand, pendingCount } from "./inbox.js";

let running = true;

function loadCkpt(): string {
  if (!existsSync(CHECKPOINT_FILE)) return "";
  try { return (JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8")) as { last_msg_id?: string }).last_msg_id ?? ""; } catch { return ""; }
}
function saveCkpt(msgId: string, msgTime: string): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ last_msg_id: msgId, last_time: msgTime }));
}

export function writePid(): void { writeFileSync(PID_FILE, String(process.pid)); }
export function removePid(): void { try { unlinkSync(PID_FILE); } catch { /* */ } }
export function isRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try { process.kill(Number(readFileSync(PID_FILE, "utf-8").trim()), 0); return true; }
  catch { try { unlinkSync(PID_FILE); } catch { /* */ } return false; }
}

process.on("SIGTERM", () => { running = false; log("SIGTERM, 退出中..."); });
process.on("SIGINT", () => { running = false; log("SIGINT, 退出中..."); });

async function processNewMessages(): Promise<string[]> {
  const lastId = loadCkpt();
  const messages = await listReceivedMessages(20, true);
  const newMsgs = [];
  for (const msg of messages) { if (msg.message_id === lastId) break; newMsgs.push(msg); }
  if (!newMsgs.length) return [];

  for (const msg of newMsgs.reverse()) {
    const id = msg.message_id, chatId = msg.chat_id, sender = msg.sender?.id ?? "unknown";
    const text = extractText(msg);
    if (!text || text.length < 2) continue;
    log(`📨 [${sender}] ${text.slice(0, 80)}`);
    enqueueCommand(id, chatId, sender, text, msg.create_time);
    await replyCard(id, "✅ 收到指令", `内容：${text.slice(0, 200)}\nClaude Code 正在处理，请稍候…`);
  }
  saveCkpt(messages[0]?.message_id ?? "", messages[0]?.create_time ?? "");
  return newMsgs.map(m => m.message_id);
}

export async function pollLoop(): Promise<number> {
  log(`🚀 监听启动 (间隔 ${config.pollInterval}s)`);
  let errors = 0;
  while (running) {
    try { const ids = await processNewMessages(); if (ids.length) log(`✓ ${ids.length} 条, 待处理: ${pendingCount()}`); errors = 0; }
    catch (e) { errors++; log(`异常(${errors}): ${e}`, "ERROR"); if (errors > 10) { log("暂停 30s", "WARN"); await sleep(30_000); errors = 0; } }
    await sleep(config.pollInterval * 1000);
  }
  log("监听已停止"); return 0;
}

export async function runOnce(): Promise<void> {
  const ids = await processNewMessages();
  console.log(`处理 ${ids.length} 条新消息`);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
