import test from "node:test";
import assert from "node:assert/strict";
import { registerSession, getSession, findByPrefix, markIdle, updateHeartbeat, removeSession, listActive, isProcessAlive } from "../src/session/state.js";
import { storage } from "../src/utils/storage.js";

function make(overrides: Record<string, unknown> = {}) {
  return { session_id: "test-sid-001", pid: process.pid, tty: "ttys001", transcript_path: "/tmp/t.jsonl", status: "active" as const, started_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(), ...overrides };
}

test("registerSession creates a new session", () => {
  storage.reset();
  registerSession(make());
  assert.ok(getSession("test-sid-001"));
});

test("getSession returns null for unknown session", () => {
  storage.reset();
  assert.equal(getSession("nonexistent"), null);
});

test("findByPrefix matches prefix >= 8 chars", () => {
  storage.reset();
  registerSession(make({ session_id: "abc123-def456-ghi789" }));
  assert.equal(findByPrefix("abc123-def456")!.session_id, "abc123-def456-ghi789");
});

test("findByPrefix returns null for prefix < 8 chars", () => {
  storage.reset();
  registerSession(make({ session_id: "abc123-def456-ghi789" }));
  assert.equal(findByPrefix("abc123-"), null);
});

test("isProcessAlive returns true for running process", () => {
  assert.ok(isProcessAlive(process.pid));
});

test("isProcessAlive returns false for non-existent PID", () => {
  assert.equal(isProcessAlive(99999), false);
});

test("listActive filters dead processes", () => {
  storage.reset();
  registerSession(make({ session_id: "alive-1", pid: process.pid }));
  registerSession(make({ session_id: "dead-1", pid: 99999 }));
  const ids = listActive().map(s => s.session_id);
  assert.ok(ids.includes("alive-1"));
  assert.ok(!ids.includes("dead-1"));
});

test("markIdle sets status to idle", () => {
  storage.reset();
  registerSession(make({ session_id: "idle-test" }));
  markIdle("idle-test");
  assert.equal(getSession("idle-test")!.status, "idle");
});

test("updateHeartbeat refreshes timestamp", () => {
  storage.reset();
  registerSession(make({ session_id: "hb-test", last_heartbeat: new Date(Date.now() - 3600_000).toISOString() }));
  updateHeartbeat("hb-test");
  assert.ok(new Date(getSession("hb-test")!.last_heartbeat).getTime() > Date.now() - 5000);
});

test("removeSession deletes record", () => {
  storage.reset();
  registerSession(make({ session_id: "rm-test" }));
  removeSession("rm-test");
  assert.equal(getSession("rm-test"), null);
});

test("registerSession marks old sessions with same PID as idle", () => {
  storage.reset();
  registerSession(make({ session_id: "old-session", pid: process.pid }));
  registerSession(make({ session_id: "new-session", pid: process.pid }));
  assert.equal(getSession("old-session")!.status, "idle");
  assert.equal(getSession("new-session")!.status, "active");
});
