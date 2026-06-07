import test from "node:test";
import assert from "node:assert/strict";
import { enqueue, markDelivered } from "../src/session/queue.js";
import { recordDelivery, clearDelivery } from "../src/session/delivery.js";
import { registerSession, markIdle, updateHeartbeat } from "../src/session/state.js";
import { registerCardSession } from "../src/feishu/api.js";
import { storage } from "../src/utils/storage.js";

function msg(id: string) {
  return {
    id,
    chat_id: "oc_1",
    sender: "ou_1",
    content: `${id} content`,
    received_at: new Date().toISOString(),
    status: "pending" as const,
  };
}

function session(id: string) {
  return {
    session_id: id,
    pid: process.pid,
    tty: "ttys001",
    transcript_path: "/tmp/transcript.jsonl",
    status: "active" as const,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
}

test("queue operations replace message collections and records instead of mutating them", () => {
  storage.reset();
  enqueue(msg("m1"));

  const beforeMessages = storage.messages;
  const beforeMessage = storage.messages[0];

  markDelivered("m1");

  assert.notEqual(storage.messages, beforeMessages);
  assert.notEqual(storage.messages[0], beforeMessage);
  assert.equal(beforeMessage.status, "pending");
  assert.equal(storage.messages[0].status, "delivered");
});

test("session operations replace session collections and records instead of mutating them", () => {
  storage.reset();
  registerSession(session("sid-1"));

  const beforeSessions = storage.sessions;
  const beforeSession = storage.sessions[0];

  markIdle("sid-1");

  assert.notEqual(storage.sessions, beforeSessions);
  assert.notEqual(storage.sessions[0], beforeSession);
  assert.equal(beforeSession.status, "active");
  assert.equal(storage.sessions[0].status, "idle");

  const afterIdleSessions = storage.sessions;
  updateHeartbeat("sid-1");
  assert.notEqual(storage.sessions, afterIdleSessions);
});

test("delivery and card maps replace storage objects when updated", () => {
  storage.reset();
  const beforeDelivery = storage.delivery;
  const beforeCardMap = storage.cardMap;

  recordDelivery("sid-1", "om_1");
  registerCardSession("om_card_1", "sid-1");

  assert.notEqual(storage.delivery, beforeDelivery);
  assert.notEqual(storage.cardMap, beforeCardMap);

  const withDelivery = storage.delivery;
  clearDelivery("sid-1");
  assert.notEqual(storage.delivery, withDelivery);
  assert.equal(storage.delivery["sid-1"], undefined);
});
