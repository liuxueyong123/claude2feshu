import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeMsg(id: string, sessionId?: string) {
  return {
    id,
    chat_id: "oc_1",
    sender: "ou_1",
    content: `${id} content`,
    ...(sessionId ? { session_id: sessionId } : {}),
    received_at: new Date().toISOString(),
    status: "pending" as const,
  };
}

test("deliverNextPending sends only one current-session message per trigger", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "claude2feishu-delivery-"));
  const oldDataDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const queue = await import(`../src/message_queue.ts?case=one-shot-${Date.now()}`);
    const orchestrator = await import(`../src/delivery_orchestrator.ts?case=one-shot-${Date.now()}`);
    const sent: string[] = [];
    const replies: string[] = [];

    queue.enqueue(makeMsg("s1", "sid_1"));
    queue.enqueue(makeMsg("s2", "sid_1"));
    queue.enqueue(makeMsg("inbox_1"));

    const result = await orchestrator.deliverNextPending({
      sessionId: "sid_1",
      tty: "ttys001",
      transcriptPath: "",
      pid: process.pid,
      getState: () => "waiting",
      sendViaITerm: (_tty: string, message: string) => {
        sent.push(message);
        return true;
      },
      replyCard: async (msgId: string) => {
        replies.push(msgId);
        return "ok";
      },
    });

    assert.equal(result.sent, 1);
    assert.equal(result.remaining, 2);
    assert.deepEqual(sent, ["s1 content"]);
    assert.deepEqual(replies, ["s1"]);
    assert.deepEqual(queue.getPending("sid_1").map((m) => m.id), ["s2"]);
    assert.deepEqual(queue.getInboxPending().map((m) => m.id), ["inbox_1"]);
  } finally {
    if (oldDataDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
