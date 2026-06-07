import test from "node:test";
import assert from "node:assert/strict";
import { enqueue, getPending, getInboxPending } from "../src/session/queue.js";
import { storage } from "../src/storage.js";
import { deliverNextPending } from "../src/session/delivery.js";

test("deliverNextPending sends only one current-session message per trigger", async () => {
  storage.reset();
  enqueue({ id: "s1", chat_id: "oc_1", sender: "ou_1", content: "s1 content", session_id: "sid_1", received_at: new Date().toISOString(), status: "pending" });
  enqueue({ id: "s2", chat_id: "oc_1", sender: "ou_1", content: "s2 content", session_id: "sid_1", received_at: new Date().toISOString(), status: "pending" });
  enqueue({ id: "inbox_1", chat_id: "oc_1", sender: "ou_1", content: "inbox_1 content", received_at: new Date().toISOString(), status: "pending" });
  const sent: string[] = [];
  const replies: string[] = [];
  const result = await deliverNextPending({
    sessionId: "sid_1", tty: "ttys001", transcriptPath: "", pid: process.pid,
    getState: () => "waiting",
    sendToTerminal: (_tty, msg) => { sent.push(msg); return true; },
    replyCard: async (msgId) => { replies.push(msgId); return "ok"; },
  });
  assert.equal(result.sent, 1);
  assert.equal(result.remaining, 2);
  assert.deepEqual(sent, ["s1 content"]);
  assert.deepEqual(getPending("sid_1").map(m => m.id), ["s2"]);
  assert.deepEqual(getInboxPending().map(m => m.id), ["inbox_1"]);
});
