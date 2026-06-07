import test from "node:test";
import assert from "node:assert/strict";
import { enqueue, getPending, pendingCount, markDelivered, clearDelivered, listPendingSessions } from "../src/session/queue.js";
import { storage } from "../src/storage.js";

function m(id: string, sid?: string) {
  return { id, chat_id: "oc_1", sender: "ou_1", content: `${id} cnt`, session_id: sid, received_at: new Date().toISOString(), status: "pending" as const };
}

test("separates inbox and session pending messages", () => {
  storage.reset();
  enqueue(m("1")); enqueue(m("2", "sid_a")); enqueue(m("3")); enqueue(m("4", "sid_b"));
  assert.equal(pendingCount(), 4);
  assert.equal(pendingCount("sid_a"), 1);
});

test("pendingCount returns total", () => {
  storage.reset();
  enqueue(m("1")); enqueue(m("2"));
  assert.equal(pendingCount(), 2);
});

test("pendingCount filters by session", () => {
  storage.reset();
  enqueue(m("1", "sid_a")); enqueue(m("2", "sid_b")); enqueue(m("3", "sid_a"));
  assert.equal(pendingCount("sid_a"), 2);
});

test("clearDelivered removes delivered, keeps pending", () => {
  storage.reset();
  enqueue(m("1")); enqueue(m("2")); enqueue(m("3"));
  markDelivered("1"); markDelivered("3");
  assert.equal(clearDelivered(), 2);
  assert.equal(pendingCount(), 1);
});

test("listPendingSessions groups correctly", () => {
  storage.reset();
  enqueue(m("1")); enqueue(m("2", "sid_a")); enqueue(m("3", "sid_a")); enqueue(m("4", "sid_b"));
  const g = listPendingSessions();
  assert.equal(g.length, 2);
  assert.equal(g.find(x => x.session_id === "sid_a")!.count, 2);
});
