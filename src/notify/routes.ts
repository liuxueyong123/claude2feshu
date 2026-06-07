import Router from "@koa/router";
import { processHookEvent, checkInboxText, popInboxCommand } from "./index.js";
import type { HookEvent } from "./index.js";
import { markDelivered, clearDelivered } from "../session/queue.js";
import { replyCard } from "../feishu/api.js";
import { log } from "../logger.js";

const router = new Router();

router.post("/hook", async (ctx) => {
  const body = ctx.request.body as Record<string, unknown> | undefined;
  if (!body || Object.keys(body).length === 0) {
    ctx.status = 400; ctx.body = { error: "empty body" }; return;
  }
  const event = body as unknown as HookEvent;
  const title = (ctx.query.title as string) ?? "Claude Code";
  const message = (ctx.query.message as string) ?? "";
  const type = (ctx.query.type as string) ?? "info";
  const includeBashErrors = "include-bash-errors" in ctx.query;
  log(`hook: ${event.hook_event_name ?? "unknown"} session=${(event.session_id ?? "").slice(0, 16)}`, "DEBUG");
  await processHookEvent(event, title, message, type, { includeBashErrors });
  ctx.body = { ok: true };
});

router.get("/inbox", (ctx) => {
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = checkInboxText();
});

router.post("/inbox/pop", (ctx) => {
  ctx.type = "text/plain; charset=utf-8";
  ctx.body = popInboxCommand();
});

router.post("/inbox/done/:id", (ctx) => {
  markDelivered(ctx.params.id);
  ctx.body = { ok: true };
});

router.post("/inbox/reply", async (ctx) => {
  const { msgId, text } = (ctx.request.body as Record<string, string>) ?? {};
  if (!msgId || !text) { ctx.status = 400; ctx.body = { error: "msgId and text required" }; return; }
  const escaped = text.replace(/```/g, "``​`");
  const ok = await replyCard(msgId, "✅ 结果", `\`\`\`\n${escaped}\n\`\`\`\n\n— Claude Code`, "green");
  if (ok) markDelivered(msgId);
  ctx.body = { ok: !!ok };
});

router.post("/inbox/clear", (ctx) => {
  const n = clearDelivered();
  ctx.body = { ok: true, cleared: n };
});

export { router };
