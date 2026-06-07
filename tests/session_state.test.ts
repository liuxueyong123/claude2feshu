import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSessionState(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "test-sid-001",
    pid: process.pid,
    tty: "ttys001",
    transcript_path: "/tmp/transcript.jsonl",
    status: "active" as const,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    ...overrides,
  };
}

test("registerSession creates a new session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, getSession } = await import(`../src/session_state.ts?case=new-${Date.now()}`);
    registerSession(makeSessionState());
    const found = getSession("test-sid-001");
    assert.ok(found);
    assert.equal(found!.pid, process.pid);
    assert.equal(found!.tty, "ttys001");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("getSession returns null for unknown session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { getSession } = await import(`../src/session_state.ts?case=unknown-${Date.now()}`);
    assert.equal(getSession("nonexistent"), null);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("findByPrefix matches session_id by prefix (>= 8 chars)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, findByPrefix } = await import(`../src/session_state.ts?case=prefix-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "abc123-def456-ghi789" }));
    const prefix = findByPrefix("abc123-def456");
    assert.ok(prefix);
    assert.equal(prefix!.session_id, "abc123-def456-ghi789");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("findByPrefix returns null for prefix shorter than 8 characters", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, findByPrefix } = await import(`../src/session_state.ts?case=short-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "abc123-def456-ghi789" }));
    assert.equal(findByPrefix("abc123-"), null); // 7 chars
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("isProcessAlive returns true for running process", async () => {
  const { isProcessAlive } = await import("../src/session_state.js");
  assert.ok(isProcessAlive(process.pid));
});

test("isProcessAlive returns false for non-existent PID", async () => {
  const { isProcessAlive } = await import("../src/session_state.js");
  assert.equal(isProcessAlive(99999), false);
});

test("listActive filters out sessions with dead processes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, listActive } = await import(`../src/session_state.ts?case=listactive-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "alive-1", pid: process.pid, status: "active" }));
    registerSession(makeSessionState({ session_id: "dead-1", pid: 99999, status: "active" }));

    const active = listActive();
    const ids = active.map((s) => s.session_id);
    assert.ok(ids.includes("alive-1"));
    assert.ok(!ids.includes("dead-1"));
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("markIdle sets session status to idle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, markIdle, getSession } = await import(`../src/session_state.ts?case=markidle-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "mark-idle-test", status: "active" }));
    markIdle("mark-idle-test");
    assert.equal(getSession("mark-idle-test")!.status, "idle");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("updateHeartbeat refreshes last_heartbeat to near-now", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, updateHeartbeat, getSession } = await import(`../src/session_state.ts?case=heartbeat-${Date.now()}`);
    const oldTime = new Date(Date.now() - 3600_000).toISOString();
    registerSession(makeSessionState({ session_id: "hb-test", last_heartbeat: oldTime }));
    updateHeartbeat("hb-test");
    assert.ok(new Date(getSession("hb-test")!.last_heartbeat).getTime() > Date.now() - 5000);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("removeSession deletes session record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, removeSession, getSession } = await import(`../src/session_state.ts?case=remove-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "rm-test" }));
    assert.ok(getSession("rm-test"));
    removeSession("rm-test");
    assert.equal(getSession("rm-test"), null);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("registerSession marks old sessions with same PID as idle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-session-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { registerSession, getSession } = await import(`../src/session_state.ts?case=pid-dedup-${Date.now()}`);
    registerSession(makeSessionState({ session_id: "old-session", pid: process.pid, status: "active" }));
    registerSession(makeSessionState({ session_id: "new-session", pid: process.pid, status: "active" }));

    assert.equal(getSession("old-session")!.status, "idle");
    assert.equal(getSession("new-session")!.status, "active");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
