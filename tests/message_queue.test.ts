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

test("message queue separates inbox and session pending messages", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "claude2feishu-message-queue-"));
  const oldDataDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mod = await import(`../src/message_queue.ts?case=separate-${Date.now()}`);

    mod.enqueue(makeMsg("inbox_1"));
    mod.enqueue(makeMsg("session_1", "sid_1"));

    assert.deepEqual(mod.getInboxPending().map((m) => m.id), ["inbox_1"]);
    assert.deepEqual(mod.getPending("sid_1").map((m) => m.id), ["session_1"]);
    assert.deepEqual(mod.getPending().map((m) => m.id), ["inbox_1", "session_1"]);

    mod.markDelivered("inbox_1");
    assert.deepEqual(mod.getInboxPending().map((m) => m.id), []);
    assert.deepEqual(mod.getPending("sid_1").map((m) => m.id), ["session_1"]);
  } finally {
    if (oldDataDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
