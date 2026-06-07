import test from "node:test";
import assert from "node:assert/strict";
import { checkInboxText, popInboxCommand } from "../src/notify/index.js";
import { enqueue } from "../src/session/queue.js";
import { storage } from "../src/storage.js";

test("checkInboxText says empty when no pending inbox items", () => {
  storage.reset();
  assert.ok(checkInboxText().includes("无待处理指令"));
});

test("checkInboxText lists pending inbox messages", () => {
  storage.reset();
  enqueue({ id: "om_test_1", chat_id: "oc_1", sender: "ou_user", content: "运行测试", received_at: new Date().toISOString(), status: "pending" });
  assert.ok(checkInboxText().includes("运行测试"));
});

test("popInboxCommand says empty when no pending items", () => {
  storage.reset();
  assert.ok(popInboxCommand().includes("无待处理指令"));
});

test("popInboxCommand returns first pending inbox command", () => {
  storage.reset();
  enqueue({ id: "om_test_2", chat_id: "oc_1", sender: "ou_user2", content: "部署生产环境", received_at: new Date().toISOString(), status: "pending" });
  assert.ok(popInboxCommand().includes("部署生产环境"));
});
