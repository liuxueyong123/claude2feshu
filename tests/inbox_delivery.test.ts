import test from "node:test";
import assert from "node:assert/strict";
import { deliverInboxPendingToTerminal } from "../src/inbox_delivery.ts";
import type { InboxItem } from "../src/inbox.ts";
import type { ClaudeState } from "../src/terminal.ts";

function inboxItem(id: string, content: string): InboxItem {
  return {
    id,
    chat_id: "oc_test",
    sender: "ou_test",
    content,
    received_at: "1717603200000",
    created_at: new Date().toISOString(),
    status: "pending",
  };
}

test("deliverInboxPendingToTerminal sends pending inbox messages and marks sent items done", async () => {
  const sent: string[] = [];
  const done: string[] = [];

  const result = await deliverInboxPendingToTerminal(
    [inboxItem("om_1", "run tests")],
    {
      getState: () => "waiting" as ClaudeState,
      send: (message) => {
        sent.push(message);
        return true;
      },
      markDone: (id, resultText) => done.push(`${id}:${resultText}`),
      sleep: async () => undefined,
    },
    {
      pollIntervalMs: 1,
      maxWaitMs: 10,
      postSendBusyWaitMs: 5,
    },
  );

  assert.deepEqual(sent, ["run tests"]);
  assert.deepEqual(done, ["om_1:sent_to_terminal"]);
  assert.equal(result.sent, 1);
  assert.equal(result.remaining, 0);
});

test("deliverInboxPendingToTerminal leaves failed sends pending", async () => {
  const done: string[] = [];

  const result = await deliverInboxPendingToTerminal(
    [inboxItem("om_1", "run tests")],
    {
      getState: () => "waiting" as ClaudeState,
      send: () => false,
      markDone: (id) => done.push(id),
      sleep: async () => undefined,
    },
    {
      pollIntervalMs: 1,
      maxWaitMs: 10,
      postSendBusyWaitMs: 5,
    },
  );

  assert.deepEqual(done, []);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 1);
});
