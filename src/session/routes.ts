import Router from "@koa/router";
import { listActive, getSession } from "./state.js";
import { getPending, listPendingSessions } from "./queue.js";
import { detectState, sendToTerminal } from "../utils/terminal.js";

const router = new Router();

router.get("/sessions", (ctx) => {
  const active = listActive();
  const pending = listPendingSessions();
  ctx.body = {
    active: active.map((s) => ({
      id: s.session_id, pid: s.pid, tty: s.tty,
      status: s.status, started: s.started_at,
    })),
    pending: pending.map((p) => ({ session: p.session_id, count: p.count })),
  };
});

router.get("/sessions/:id", (ctx) => {
  const s = getSession(ctx.params.id);
  if (!s) { ctx.status = 404; ctx.body = { error: "session not found" }; return; }
  ctx.body = { ...s, claudeState: detectState(s.transcript_path) };
});

router.get("/sessions/:id/queue", (ctx) => {
  const sq = getPending(ctx.params.id);
  ctx.body = sq.map((m) => ({
    id: m.id, sender: m.sender, content: m.content,
    received: m.received_at, status: m.status,
  }));
});

router.post("/sessions/:id/send", (ctx) => {
  const session = getSession(ctx.params.id);
  if (!session) { ctx.status = 404; ctx.body = { error: "session not found" }; return; }
  const { message } = (ctx.request.body as Record<string, string>) ?? {};
  if (!message) { ctx.status = 400; ctx.body = { error: "message required" }; return; }
  ctx.body = { ok: sendToTerminal(session.tty, message) };
});

export { router };
