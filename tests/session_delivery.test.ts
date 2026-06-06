import test from "node:test";
import assert from "node:assert/strict";
import { deliverMessagesSequentially } from "../src/session_delivery.ts";
import type { ClaudeState } from "../src/terminal.ts";

test("deliverMessagesSequentially does not send the next message until the session leaves waiting", async () => {
  const sent: string[] = [];
  const delivered: string[] = [];

  const result = await deliverMessagesSequentially(
    [
      { id: "m1", content: "first" },
      { id: "m2", content: "second" },
    ],
    {
      getState: () => "waiting" as ClaudeState,
      send: (message) => {
        sent.push(message);
        return true;
      },
      markDelivered: (id) => delivered.push(id),
      sleep: async () => undefined,
    },
    {
      pollIntervalMs: 1,
      maxWaitMs: 10,
      postSendBusyWaitMs: 5,
    },
  );

  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(delivered, ["m1"]);
  assert.equal(result.sent, 1);
  assert.equal(result.remaining, 1);
});

test("deliverMessagesSequentially can wait for the final sent message to start processing", async () => {
  let state: ClaudeState = "waiting";
  const sleeps: number[] = [];

  const result = await deliverMessagesSequentially(
    [{ id: "m1", content: "first" }],
    {
      getState: () => state,
      send: () => true,
      markDelivered: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
        state = "busy";
      },
    },
    {
      pollIntervalMs: 1,
      maxWaitMs: 10,
      postSendBusyWaitMs: 5,
      waitAfterLast: true,
    },
  );

  assert.deepEqual(sleeps, [1]);
  assert.equal(result.sent, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.reason, "done");
});
