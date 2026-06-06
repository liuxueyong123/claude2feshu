/**
 * 飞书 Open API 客户端 — token / 消息拉取 / @过滤 / 回复
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, API_BASE, REQUEST_TIMEOUT_MS } from "./config.js";
import { log } from "./logger.js";

let _token = { value: "", expiresAt: 0 };
let _botOpenId = "";

// ---- 类型 ----

export interface FeishuMessage {
  message_id: string;
  msg_type: string;
  chat_id: string;
  create_time: string;
  sender: { id: string; id_type?: string };
  body: { content: string };
  mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
  _chat_name?: string;
}

export interface FeishuChat {
  chat_id: string;
  name: string;
}

// ---- 请求封装 ----

async function req(method: string, path: string, body?: unknown, params?: Record<string, string>, auth = true): Promise<[number, Record<string, unknown>]> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (auth) {
    const token = await getToken();
    if (!token) return [-1, { error: "token_failed" }];
    headers["Authorization"] = `Bearer ${token}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    clearTimeout(t);
    const data = (await res.json()) as Record<string, unknown>;
    return [(data.code as number) ?? res.status, data];
  } catch (e) {
    log(`请求失败 ${method} ${path}: ${e}`, "ERROR");
    return [-1, { error: String(e) }];
  }
}

// ---- 认证 ----

async function getToken(): Promise<string> {
  if (_token.value && _token.expiresAt > Date.now() / 1000 + 60) return _token.value;
  if (!config.appId || !config.appSecret) {
    log("缺少 FEISHU_APP_ID/SECRET", "ERROR");
    return "";
  }
  const [code, data] = await req("POST", "/auth/v3/tenant_access_token/internal", { app_id: config.appId, app_secret: config.appSecret }, undefined, false);
  if (code === 0) {
    _token = { value: data.tenant_access_token as string, expiresAt: Date.now() / 1000 + ((data.expire as number) ?? 7200) };
    log("token 刷新", "DEBUG");
    return _token.value;
  }
  log(`token 失败: ${JSON.stringify(data)}`, "ERROR");
  return "";
}

async function getBotOpenId(): Promise<string> {
  if (_botOpenId) return _botOpenId;
  const [code, data] = await req("GET", "/bot/v3/info");
  if (code === 0) {
    _botOpenId = (data.bot as Record<string, string>)?.open_id ?? "";
    log(`Bot id: ${_botOpenId}`, "DEBUG");
  }
  return _botOpenId;
}

// ---- 群聊 & 消息 ----

export async function listChats(): Promise<FeishuChat[]> {
  const [code, data] = await req("GET", "/im/v1/chats", undefined, { page_size: "50" });
  return code === 0 ? (((data.data as Record<string, unknown>)?.items as FeishuChat[]) ?? []) : [];
}

export async function listChatMessages(chatId: string, pageSize = 20, pageToken?: string) {
  const params: Record<string, string> = { container_id_type: "chat", container_id: chatId, page_size: String(Math.min(pageSize, 50)), sort_type: "ByCreateTimeDesc" };
  if (pageToken) params.page_token = pageToken;
  const [code, data] = await req("GET", "/im/v1/messages", undefined, params);
  if (code === 0) {
    const d = data.data as Record<string, unknown>;
    return { items: (d?.items as FeishuMessage[]) ?? [], hasMore: (d?.has_more as boolean) ?? false, pageToken: (d?.page_token as string) ?? "" };
  }
  log(`消息列表失败: ${JSON.stringify(data)}`, "WARN");
  return { items: [], hasMore: false, pageToken: "" };
}

export async function listReceivedMessages(pageSize = 20, onlyMentions = true): Promise<FeishuMessage[]> {
  const all: FeishuMessage[] = [];
  const botId = onlyMentions ? await getBotOpenId() : "";
  const chats = await listChats();
  if (!chats.length) {
    log("未找到群聊，请确认机器人已入群", "WARN");
    return [];
  }
  for (const chat of chats) {
    const { items } = await listChatMessages(chat.chat_id, pageSize);
    for (const msg of items) {
      if (onlyMentions && !mentionsBot(msg, botId)) continue;
      (msg as unknown as Record<string, unknown>)._chat_name = chat.name;
      all.push(msg);
    }
  }
  all.sort((a, b) => b.create_time.localeCompare(a.create_time));
  log(`聚合: ${all.length} 条 (@过滤, ${chats.length} 群)`, "DEBUG");
  return all.slice(0, pageSize);
}

// ---- @提及检测 ----

function mentionsBot(msg: FeishuMessage, botId: string): boolean {
  const content = msg.body?.content;
  if (!content) return false;
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const text = (obj.text as string) ?? "";
    if (text.includes("@")) {
      if (botId) return text.includes(botId);
      return true;
    }
    if (obj.content && typeof obj.content === "object") return hasAt(obj.content);
  } catch {
    /* */
  }
  return false;
}

function hasAt(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasAt);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.tag === "at") return true;
    return Object.values(obj).some(hasAt);
  }
  return false;
}

// ---- 文本提取 ----

export function extractText(msg: FeishuMessage): string {
  const content = msg.body?.content;
  if (!content) return "";
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const text = (obj.text as string) ?? "";
    if (text && msg.msg_type === "text") {
      let s = text.trim();
      while (s.startsWith("@")) {
        const sp = s.indexOf(" ");
        s = sp >= 0 ? s.slice(sp).trim() : s.replace(/^@\S+/, "").trim();
        if (!sp) break;
      }
      return s;
    }
    if (msg.msg_type === "post") return extractPostText(obj.content);
  } catch {
    return content;
  }
  return "";
}

function extractPostText(node: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(node)) {
    for (const i of node) parts.push(extractPostText(i));
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.tag === "text") parts.push((obj.text as string) ?? "");
    if (obj.tag === "at") parts.push(`@${obj.user_name ?? ""}`);
    for (const v of Object.values(obj)) parts.push(extractPostText(v));
  }
  return parts.join("");
}

// ---- 回复指定消息 ----

export async function replyCard(msgId: string, title: string, content: string, color = "blue"): Promise<boolean> {
  const card = buildCard(title, content, color);
  const [code] = await req("POST", `/im/v1/messages/${msgId}/reply`, { content: card, msg_type: "interactive" });
  return code === 0;
}

// ---- 发送消息到群聊（API 方式，替代 webhook） ----

/**
 * 构建卡片 JSON 字符串（飞书卡片 JSON 2.0，schema: "2.0"）
 * JSON 2.0 的 markdown 组件支持代码块、行内代码、标题等完整语法。
 * 需飞书客户端 ≥ 7.20（2024+ 版本）。
 */
function buildCard(title: string, content: string, color: string): string {
  const timeStr = new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template: color },
    body: {
      elements: [{ tag: "markdown", content }, { tag: "hr" }, { tag: "markdown", content: `*⏱ ${timeStr}  ·  Claude Code*`, text_size: "notation" }],
    },
  });
}

/** 通过 API 向指定群聊发送卡片消息 */
export async function sendChatCard(title: string, content: string, color = "blue"): Promise<boolean> {
  const chatId = config.chatId || (await getDefaultChatId());
  if (!chatId) {
    const msg = "未配置 FEISHU_CHAT_ID 且无可用群聊";
    log(msg, "ERROR");
    errlog(msg);
    return false;
  }

  const card = buildCard(title, content, color);
  const [code, data] = await req("POST", `/im/v1/messages?receive_id_type=chat_id`, { receive_id: chatId, msg_type: "interactive", content: card });

  if (code !== 0) {
    const msg = `API 发送失败: code=${code} data=${JSON.stringify(data)} chatId=${chatId}`;
    log(msg, "ERROR");
    errlog(msg);
    return false;
  }
  log(`消息已发送到 ${chatId.slice(0, 16)}...`, "INFO");
  return true;
}

/** 将错误写入文件，方便 hook 环境下排查 */
function errlog(msg: string) {
  try {
    appendFileSync(resolve(process.env.HOME ?? "/tmp", ".claude", "feishu_error.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

let _defaultChatId = "";

async function getDefaultChatId(): Promise<string> {
  if (_defaultChatId) return _defaultChatId;
  const chats = await listChats();
  if (chats.length > 0) {
    _defaultChatId = chats[0].chat_id;
    log(`自动选择群聊: ${chats[0].name || _defaultChatId}`, "INFO");
  }
  return _defaultChatId;
}
