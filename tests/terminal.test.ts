import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTranscript(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function writeTempTranscript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "c2f-term-"));
  const file = join(dir, "transcript.jsonl");
  writeFileSync(file, makeTranscript(lines));
  return file;
}

function cleanupTempFile(filePath: string): void {
  const dir = filePath.replace(/\/[^/]+$/, "");
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

// ============================================================
// detectState
// ============================================================

test("detectState returns 'waiting' when last assistant message has stop_reason=end_turn", async () => {
  const { detectState } = await import("../src/terminal.js");
  const file = writeTempTranscript([
    { message: { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
  ]);

  const state = detectState(file);
  assert.equal(state, "waiting");
  cleanupTempFile(file);
});

test("detectState returns 'busy' when last assistant message has stop_reason=tool_use", async () => {
  const { detectState } = await import("../src/terminal.js");
  const file = writeTempTranscript([
    { message: { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash" }] } },
  ]);

  const state = detectState(file);
  assert.equal(state, "busy");
  cleanupTempFile(file);
});

test("detectState returns 'busy' when last user message is recent (< 5 min)", async () => {
  const { detectState } = await import("../src/terminal.js");
  const now = new Date().toISOString();
  const file = writeTempTranscript([
    { message: { role: "user", content: [{ type: "text", text: "hello" }] }, timestamp: now },
  ]);

  const state = detectState(file);
  assert.equal(state, "busy");
  cleanupTempFile(file);
});

test("detectState returns 'gone' when last user message is older than 5 minutes", async () => {
  const { detectState } = await import("../src/terminal.js");
  const old = new Date(Date.now() - 400_000).toISOString(); // > 5 min
  const file = writeTempTranscript([
    { message: { role: "user", content: [{ type: "text", text: "hello" }] }, timestamp: old },
  ]);

  const state = detectState(file);
  assert.equal(state, "gone");
  cleanupTempFile(file);
});

test("detectState returns 'gone' when transcript file does not exist", async () => {
  const { detectState } = await import("../src/terminal.js");
  const state = detectState("/tmp/nonexistent-transcript-12345.jsonl");
  assert.equal(state, "gone");
});

test("detectState returns 'gone' when transcript path is empty string", async () => {
  const { detectState } = await import("../src/terminal.js");
  const state = detectState("");
  assert.equal(state, "gone");
});

test("detectState handles multi-line transcript and scans from back", async () => {
  const { detectState } = await import("../src/terminal.js");
  // Last message is assistant+end_turn, even though earlier user message is old
  const file = writeTempTranscript([
    { message: { role: "user", content: [{ type: "text", text: "hi" }] }, timestamp: new Date(Date.now() - 400_000).toISOString() },
    { message: { role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] } },
  ]);

  const state = detectState(file);
  assert.equal(state, "waiting");
  cleanupTempFile(file);
});

// ============================================================
// sendToTerminal
// ============================================================

test("sendToTerminal returns false for empty tty", async () => {
  const { sendToTerminal } = await import("../src/terminal.js");
  assert.equal(sendToTerminal("", "hello"), false);
});

test("sendToTerminal returns false for empty message", async () => {
  const { sendToTerminal } = await import("../src/terminal.js");
  assert.equal(sendToTerminal("ttys001", "  "), false);
});

test("sendToTerminal returns false for non-existent TTY device", async () => {
  const { sendToTerminal } = await import("../src/terminal.js");
  assert.equal(sendToTerminal("ttys99999", "hello"), false);
});

test("buildTerminalAppScript targets a Terminal tab by tty", async () => {
  const { buildTerminalAppScript } = await import("../src/terminal.js");

  const script = buildTerminalAppScript("ttys001", "hello");

  assert.match(script, /tell application "\/System\/Applications\/Utilities\/Terminal\.app"/);
  assert.match(script, /repeat with t in tabs of w/);
  assert.match(script, /if \(tty of t\) ends with "ttys001" then/);
  assert.match(script, /do script "hello" in t/);
});

test("buildTerminalAppScript escapes message text for AppleScript", async () => {
  const { buildTerminalAppScript } = await import("../src/terminal.js");

  const script = buildTerminalAppScript("ttys001", "say \"hi\"\nthen \\ ok");

  assert.match(script, /do script "say \\"hi\\" then \\\\ ok" in t/);
  assert.doesNotMatch(script, /say \\"hi\\"\nthen/);
});
