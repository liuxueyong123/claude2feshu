/**
 * 飞书 Open API 客户端 — token / 消息拉取 / @过滤 / 回复
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { storage } from "../storage.js";

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
  mentions?: Array<{ key: string; id: string | { open_id?: string }; id_type?: string; name: string; tenant_key?: string }>;
  _chat_name?: string;
}

export interface FeishuChat {
  chat_id: string;
  name: string;
}

// ---- 请求封装 ----

async function req(method: string, path: string, body?: unknown, params?: Record<string, string>, auth = true): Promise<[number, Record<string, unknown>]> {
  const url = new URL(`${config.apiBase}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (auth) {
    const token = await getToken();
    if (!token) return [-1, { error: "token_failed" }];
    headers["Authorization"] = `Bearer ${token}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
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
  return all.slice(0, pageSize);
}

// ---- @提及检测 ----

export function mentionsBot(msg: FeishuMessage, botId: string): boolean {
  if (!botId) return false;

  // 优先检查 mentions 数组（飞书结构化 @提及）
  if (msg.mentions?.length) {
    for (const m of msg.mentions) {
      // m.id 可能是字符串（直接是 open_id），也可能是对象 { open_id: "..." }
      const mid = typeof m.id === "string" ? m.id : ((m.id as Record<string, unknown>)?.open_id as string | undefined);
      if (mid === botId) return true;
    }
    return false;
  }

  // 回退：检查消息正文文本
  const content = msg.body?.content;
  if (!content) return false;
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const text = (obj.text as string) ?? "";
    if (text.includes("@")) {
      return text.includes(botId);
    }
    if (obj.content && typeof obj.content === "object") return hasAtBot(obj.content, botId);
  } catch {
    /* */
  }
  return false;
}

function hasAtBot(node: unknown, botId: string): boolean {
  if (Array.isArray(node)) return node.some((item) => hasAtBot(item, botId));
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.tag === "at") {
      return obj.user_id === botId || obj.open_id === botId || obj.id === botId;
    }
    return Object.values(obj).some((value) => hasAtBot(value, botId));
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

// ---- 引用消息解析 ----

/**
 * 从消息 body 中提取被引用的消息 ID。
 *
 * 飞书引用消息的可能结构:
 *   1. msg_type="text", body.content JSON 含 reply_to.message_id
 *   2. 消息对象顶层有 root_id / parent_id（话题回复）
 *   3. msg_type="post", 富文本内容中嵌入了引用
 */
export function getQuotedMessageId(msg: FeishuMessage): string {
  const raw = msg as unknown as Record<string, unknown>;

  // 1) 正文内显式引用（用户主动选择的目标，优先级最高）
  const content = msg.body?.content;
  if (content) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;

      // reply_to — 用户点击"引用"时附带的目标消息
      const replyTo = obj.reply_to as Record<string, unknown> | undefined;
      const mid = replyTo?.message_id as string | undefined;
      if (mid?.startsWith("om_")) return mid;

      // quote 字段
      const quote = obj.quote as Record<string, unknown> | undefined;
      const qmid = quote?.message_id as string | undefined;
      if (qmid?.startsWith("om_")) return qmid;

      // 递归查找富文本中的引用
      const rich = findQuotedInRichText(obj);
      if (rich) return rich;
    } catch {
      /* fall through */
    }
  }

  // 2) 线程父消息（用户直接在话题中回复，未显式引用其他消息时使用）
  const parent = raw.parent_id as string | undefined;
  if (parent?.startsWith("om_")) return parent;

  // 3) 线程根消息
  const root = raw.root_id as string | undefined;
  if (root?.startsWith("om_")) return root;

  return "";
}

function findQuotedInRichText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findQuotedInRichText(item);
      if (r) return r;
    }
    return "";
  }
  const obj = node as Record<string, unknown>;
  if (obj.tag === "quote" || obj.tag === "reply") {
    const mid = obj.message_id as string | undefined;
    if (mid?.startsWith("om_")) return mid;
  }
  for (const v of Object.values(obj)) {
    const r = findQuotedInRichText(v);
    if (r) return r;
  }
  return "";
}

// ---- 回复指定消息 ----

export async function replyCard(msgId: string, title: string, content: string, color = "blue", sessionId = ""): Promise<string> {
  const card = buildCard(title, content, color);
  const [code, data] = await req("POST", `/im/v1/messages/${msgId}/reply`, { content: card, msg_type: "interactive" });
  if (code !== 0) return "";
  const messageId = (data.data as Record<string, unknown>)?.message_id as string | undefined;
  if (messageId && sessionId) registerCardSession(messageId, sessionId);
  return messageId ?? "";
}

// ---- 发送消息到群聊（API 方式，替代 webhook） ----

/**
 * 构建卡片 JSON 字符串（飞书卡片 JSON 2.0，schema: "2.0"）
 * JSON 2.0 的 markdown 组件支持代码块、行内代码、标题等完整语法。
 * 需飞书客户端 ≥ 7.20（2024+ 版本）。
 */
const CARD_MAX_BYTES = 30_000;

function rawCard(title: string, content: string, color: string): string {
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

export function buildCard(title: string, content: string, color: string): string {
  const full = rawCard(title, content, color);
  if (Buffer.byteLength(full, "utf-8") <= CARD_MAX_BYTES) return full;

  const chars = Array.from(content);
  let lo = 0;
  let hi = chars.length;
  let best = rawCard(title, "", color);

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const truncated = chars.slice(0, mid).join("") + (mid < chars.length ? "\n\n…" : "");
    const candidate = rawCard(title, truncated, color);
    if (Buffer.byteLength(candidate, "utf-8") <= CARD_MAX_BYTES) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

/** 通过 API 向指定群聊发送卡片消息。返回 sent_message_id 或空字符串。 */
export async function sendChatCard(title: string, content: string, color = "blue", sessionId = ""): Promise<string> {
  const chatId = config.chatId || (await getDefaultChatId());
  if (!chatId) {
    const msg = "未配置 FEISHU_CHAT_ID 且无可用群聊";
    log(msg, "ERROR");
    log(msg);
    return "";
  }

  const card = buildCard(title, content, color);
  const [code, data] = await req("POST", `/im/v1/messages?receive_id_type=chat_id`, { receive_id: chatId, msg_type: "interactive", content: card });

  if (code !== 0) {
    const msg = `API 发送失败: code=${code} data=${JSON.stringify(data)} chatId=${chatId}`;
    log(msg, "ERROR");
    log(msg);
    return "";
  }
  const messageId = (data.data as Record<string, unknown>)?.message_id as string | undefined;
  log(`消息已发送到 ${chatId.slice(0, 16)}...`, "INFO");

  // 记录卡片→session 映射，便于引用回复时查找 session
  if (messageId && sessionId) registerCardSession(messageId, sessionId);

  return messageId ?? "";
}

// ---- 卡片 → Session 映射（数据在 storage）----

export function registerCardSession(messageId: string, sessionId: string): void {
  if (!messageId || !sessionId) return;
  storage.cardMap.set(messageId, { session_id: sessionId, sent_at: new Date().toISOString() });
  log(`card→session 已登记: ${messageId.slice(0, 16)}...`, "DEBUG");
}

export function lookupCardSession(quotedMessageId: string): string {
  return storage.cardMap.get(quotedMessageId)?.session_id ?? "";
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
