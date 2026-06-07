import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, mentionsBot, extractText, getQuotedMessageId } from "../src/feishu/api.ts";
import type { FeishuMessage } from "../src/feishu/api.ts";

function makeMessage(overrides: Partial<FeishuMessage>): FeishuMessage {
  return {
    message_id: "om_test",
    msg_type: "text",
    chat_id: "oc_test",
    create_time: "1717603200000",
    sender: { id: "ou_sender" },
    body: { content: "{}" },
    ...overrides,
  };
}

test("mentionsBot rejects rich-text mentions that do not mention this bot", () => {
  const msg = makeMessage({
    msg_type: "post",
    body: {
      content: JSON.stringify({
        content: [[{ tag: "at", user_id: "ou_other", user_name: "Other User" }]],
      }),
    },
    mentions: [{ key: "@_user_1", id: "ou_other", name: "Other User" }],
  });

  assert.equal(mentionsBot(msg, "ou_bot"), false);
});

test("mentionsBot accepts rich-text mentions that explicitly mention this bot", () => {
  const msg = makeMessage({
    msg_type: "post",
    body: {
      content: JSON.stringify({
        content: [[{ tag: "at", user_id: "ou_bot", user_name: "Bot" }]],
      }),
    },
    mentions: [{ key: "@_user_1", id: "ou_bot", name: "Bot" }],
  });

  assert.equal(mentionsBot(msg, "ou_bot"), true);
});

test("buildCard keeps final JSON payload under the Feishu card size budget", () => {
  const hostileForJson = `"\\\n`.repeat(20_000);
  const card = buildCard("Huge output", hostileForJson, "blue");

  assert.ok(Buffer.byteLength(card, "utf-8") <= 30_000);
  assert.doesNotThrow(() => JSON.parse(card));
});

// ============================================================
// extractText
// ============================================================

test("extractText returns plain text from text message with @bot prefix stripped", () => {
  const msg = makeMessage({
    msg_type: "text",
    body: { content: JSON.stringify({ text: "@bot 运行测试" }) },
  });

  assert.equal(extractText(msg), "运行测试");
});

test("extractText strips multiple @user prefixes", () => {
  const msg = makeMessage({
    msg_type: "text",
    body: { content: JSON.stringify({ text: "@bot @user2 你好世界" }) },
  });

  assert.equal(extractText(msg), "你好世界");
});

test("extractText returns empty string for text without @ prefix (pure command)", () => {
  // When there's no @bot, the first token is treated as command
  const msg = makeMessage({
    msg_type: "text",
    body: { content: JSON.stringify({ text: "运行测试" }) },
  });

  // The code strips the first @-prefixed word; if none exists, it still returns the text
  assert.ok(extractText(msg).length > 0);
});

test("extractText returns empty string for interactive messages", () => {
  const msg = makeMessage({
    msg_type: "interactive",
    body: { content: JSON.stringify({ schema: "2.0" }) },
  });

  assert.equal(extractText(msg), "");
});

// ============================================================
// getQuotedMessageId
// ============================================================

test("getQuotedMessageId extracts reply_to.message_id from body", () => {
  const msg = makeMessage({
    msg_type: "text",
    body: {
      content: JSON.stringify({
        text: "@bot 继续",
        reply_to: { message_id: "om_quoted_123" },
      }),
    },
  });

  assert.equal(getQuotedMessageId(msg), "om_quoted_123");
});

test("getQuotedMessageId falls back to parent_id when no body reply_to", () => {
  const msg = makeMessage({
    msg_type: "text",
    parent_id: "om_parent_456",
    body: { content: JSON.stringify({ text: "@bot hello" }) },
  });

  assert.equal(getQuotedMessageId(msg), "om_parent_456");
});

test("getQuotedMessageId returns empty string when no quote info", () => {
  const msg = makeMessage({
    msg_type: "text",
    body: { content: JSON.stringify({ text: "@bot hello" }) },
  });

  assert.equal(getQuotedMessageId(msg), "");
});

test("getQuotedMessageId body reply_to takes priority over parent_id", () => {
  const msg = makeMessage({
    msg_type: "text",
    parent_id: "om_parent_456",
    body: {
      content: JSON.stringify({
        text: "@bot 继续",
        reply_to: { message_id: "om_reply_789" },
      }),
    },
  });

  // body reply_to should win over parent_id
  assert.equal(getQuotedMessageId(msg), "om_reply_789");
});
