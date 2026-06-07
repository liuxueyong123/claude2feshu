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
    const mod = await import(`../src/session/queue.ts?case=separate-${Date.now()}`);

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

test("pendingCount returns total pending messages", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-mq-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mod = await import(`../src/session/queue.ts?case=count-${Date.now()}`);
    assert.equal(mod.pendingCount(), 0);
    mod.enqueue(makeMsg("a"));
    mod.enqueue(makeMsg("b"));
    assert.equal(mod.pendingCount(), 2);
    mod.markDelivered("a");
    assert.equal(mod.pendingCount(), 1);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pendingCount filters by session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-mq-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mod = await import(`../src/session/queue.ts?case=count-sid-${Date.now()}`);
    mod.enqueue(makeMsg("a", "sid_a"));
    mod.enqueue(makeMsg("b", "sid_b"));
    mod.enqueue(makeMsg("c"));
    assert.equal(mod.pendingCount("sid_a"), 1);
    assert.equal(mod.pendingCount(), 3);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("clearDelivered removes delivered messages, keeps pending", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-mq-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mod = await import(`../src/session/queue.ts?case=cleardel-${Date.now()}`);
    mod.enqueue(makeMsg("p1"));
    mod.enqueue(makeMsg("p2"));
    mod.markDelivered("p1");
    assert.equal(mod.pendingCount(), 1);
    const removed = mod.clearDelivered();
    assert.ok(removed > 0);
    assert.equal(mod.pendingCount(), 1);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("listPendingSessions groups pending by session, excludes inbox", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-mq-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mod = await import(`../src/session/queue.ts?case=lps-${Date.now()}`);
    mod.enqueue(makeMsg("a", "sid_a"));
    mod.enqueue(makeMsg("b", "sid_a"));
    mod.enqueue(makeMsg("c", "sid_b"));
    mod.enqueue(makeMsg("d"));

    const list = mod.listPendingSessions();
    const bySid = Object.fromEntries(list.map((x: { session_id: string; count: number }) => [x.session_id, x.count]));
    assert.equal(bySid["sid_a"], 2);
    assert.equal(bySid["sid_b"], 1);
    assert.equal(bySid["sid_c"], undefined);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
