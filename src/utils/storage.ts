/**
 * 统一内存存储 — 所有持久化状态集中管理
 * 启动时 load()，退出时 persist()，测试用 reset()
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "./config.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export interface SessionState {
  session_id: string; pid: number; tty: string; transcript_path: string;
  status: "active" | "idle"; started_at: string; last_heartbeat: string;
}

export interface QueuedMessage {
  id: string; chat_id: string; sender: string; content: string;
  session_id?: string; received_at: string; status: "pending" | "delivered"; delivered_at?: string;
}

interface TrackerEntry { msgId: string; timestamp: string; }
interface CardEntry { session_id: string; sent_at: string; }

// ═══════════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════════

class Storage {
  sessions: SessionState[] = [];
  messages: QueuedMessage[] = [];
  delivery: Record<string, TrackerEntry> = {};
  cardMap = new Map<string, CardEntry>();
  lastMsgId = "";
  lastMsgTime = "";

  load(): void {
    const d = config.dataDir;
    this.sessions = this._read(`${d}/sessions.json`, []);
    this.messages = this._read(`${d}/messages.json`, []);
    this.delivery = this._read(`${d}/delivery.json`, {});
    this.cardMap = new Map(this._read<[string, CardEntry][]>(`${d}/card_map.json`, []));
    const ck = this._read<{ last_msg_id?: string; last_time?: string }>(`${d}/checkpoint.json`, {});
    this.lastMsgId = ck.last_msg_id ?? ""; this.lastMsgTime = ck.last_time ?? "";
  }

  persist(): void {
    this._ensureDir();
    const cutoff = Date.now() - 24 * 3600_000;
    const alive = this.sessions.filter(s => new Date(s.last_heartbeat).getTime() > cutoff);
    this.sessions = alive;
    this._write(`${config.dataDir}/sessions.json`, alive);
    this._write(`${config.dataDir}/messages.json`, this.messages);
    this._write(`${config.dataDir}/delivery.json`, this.delivery);
    this._write(`${config.dataDir}/card_map.json`, [...this.cardMap.entries()]);
    this._write(`${config.dataDir}/checkpoint.json`, { last_msg_id: this.lastMsgId, last_time: this.lastMsgTime });
  }

  reset(): void {
    this.sessions = []; this.messages = []; this.delivery = {};
    this.cardMap.clear(); this.lastMsgId = ""; this.lastMsgTime = "";
  }

  private _read<T>(file: string, fallback: T): T {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) as T : fallback; } catch { return fallback; }
  }
  private _write(file: string, data: unknown): void {
    try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
  }
  private _ensureDir(): void {
    try { if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true }); } catch { /* ignore */ }
  }
}

export const storage = new Storage();
