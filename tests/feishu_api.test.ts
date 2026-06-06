import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, mentionsBot } from "../src/feishu_api.ts";
import type { FeishuMessage } from "../src/feishu_api.ts";

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
