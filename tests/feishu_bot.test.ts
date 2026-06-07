import test from "node:test";
import assert from "node:assert/strict";
import { buildInboxFallbackReply } from "../src/bot/index.ts";

test("buildInboxFallbackReply says the command is queued when no Claude session is active", () => {
  const reply = buildInboxFallbackReply("run tests");

  assert.equal(reply.title, "📨 已收到，等待投递");
  assert.equal(reply.color, "yellow");
  assert.match(reply.content, /指令/);
  assert.match(reply.content, /收件箱/);
  assert.match(reply.content, /下次启动后自动处理/);
  assert.doesNotMatch(reply.content, /正在处理/);
});
