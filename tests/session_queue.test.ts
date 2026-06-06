import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dequeueAll peeks pending messages without marking them delivered", async () => {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "claude2feishu-queue-"));
  process.env.HOME = home;

  try {
    const mod = await import(`../src/session_queue.ts?home=${encodeURIComponent(home)}`);
    const msg = {
      id: "om_1",
      chat_id: "oc_1",
      sender: "ou_1",
      content: "run tests",
      session_id: "sid_1",
      received_at: new Date().toISOString(),
      status: "pending" as const,
    };

    mod.enqueue(msg);

    const batch = mod.dequeueAll("sid_1");
    assert.equal(batch.length, 1);
    assert.equal(mod.getPending("sid_1").length, 1);

    mod.markDelivered("om_1");
    assert.equal(mod.getPending("sid_1").length, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
