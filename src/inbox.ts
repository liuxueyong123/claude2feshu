/** Inbox 队列管理 — JSONL 读写，供 Claude Code 消费 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { INBOX_FILE } from "./config.js";

export interface InboxItem {
  id: string; chat_id: string; sender: string; content: string;
  received_at: string; created_at: string;
  status: "pending" | "in_progress" | "done" | "failed";
  started_at?: string; done_at?: string; failed_at?: string; error?: string; result?: string;
}

export function loadInbox(): InboxItem[] {
  if (!existsSync(INBOX_FILE)) return [];
  return readFileSync(INBOX_FILE, "utf-8").split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => { try { return JSON.parse(l) as InboxItem; } catch { return null; } })
    .filter((x): x is InboxItem => x !== null);
}

function saveInbox(items: InboxItem[]): void {
  writeFileSync(INBOX_FILE, items.map(i => JSON.stringify(i)).join("\n") + "\n");
}

export function getPending(): InboxItem[] { return loadInbox().filter(c => c.status === "pending"); }

export function enqueueCommand(msgId: string, chatId: string, sender: string, content: string, receivedAt: string): void {
  const cmd: InboxItem = {
    id: msgId, chat_id: chatId, sender, content: content.trim(),
    received_at: receivedAt, created_at: new Date(Date.now() + 8 * 3600_000).toISOString(), status: "pending",
  };
  writeFileSync(INBOX_FILE, JSON.stringify(cmd) + "\n", { flag: "a" });
}

export function popNext(): InboxItem | null {
  const cmds = loadInbox();
  for (const cmd of cmds) {
    if (cmd.status === "pending") { cmd.status = "in_progress"; cmd.started_at = new Date(Date.now() + 8 * 3600_000).toISOString(); saveInbox(cmds); return cmd; }
  }
  return null;
}

export function markDone(msgId: string, result?: string): void {
  const cmds = loadInbox();
  for (const c of cmds) { if (c.id === msgId) { c.status = "done"; c.done_at = new Date(Date.now() + 8 * 3600_000).toISOString(); if (result) c.result = result; } }
  saveInbox(cmds);
}

export function pendingCount(): number { return getPending().length; }

export function clearDone(): number {
  const cmds = loadInbox(), keep = cmds.filter(c => c.status === "pending" || c.status === "in_progress");
  const n = cmds.length - keep.length; saveInbox(keep); return n;
}
