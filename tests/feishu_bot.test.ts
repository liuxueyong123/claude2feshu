import test from "node:test";
import assert from "node:assert/strict";
import { buildInboxFallbackReply } from "../src/feishu_bot.ts";

test("buildInboxFallbackReply says the command is queued when no Claude session is active", () => {
  const reply = buildInboxFallbackReply("run tests");

  assert.equal(reply.title, "⏳ 等待 Claude Code 启动");
  assert.equal(reply.color, "yellow");
  assert.match(reply.content, /当前没有可用的 Claude Code 终端/);
  assert.match(reply.content, /已暂存到 inbox/);
  assert.match(reply.content, /启动 Claude Code 后会自动发送到终端/);
  assert.doesNotMatch(reply.content, /正在处理/);
});
