import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("checkInboxText says empty when no pending inbox items", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-notify-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { checkInboxText } = await import(`../src/notify.ts?case=empty-${Date.now()}`);
    assert.ok(checkInboxText().includes("无待处理指令"));
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("checkInboxText lists pending inbox messages", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-notify-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mq = await import(`../src/message_queue.ts?case=notify-inbox-${Date.now()}`);
    mq.enqueue({
      id: "om_test_1",
      chat_id: "oc_1",
      sender: "ou_user",
      content: "运行测试",
      received_at: new Date().toISOString(),
      status: "pending",
    });

    const { checkInboxText } = await import(`../src/notify.ts?case=inbox-${Date.now()}`);
    const text = checkInboxText();
    assert.ok(text.includes("运行测试"));
    assert.ok(text.includes("ou_user"));
    assert.ok(text.includes("om_test_1"));
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("popInboxCommand says empty when no pending items", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-notify-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { popInboxCommand } = await import(`../src/notify.ts?case=pop-empty-${Date.now()}`);
    assert.ok(popInboxCommand().includes("无待处理指令"));
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("popInboxCommand returns first pending inbox command", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-notify-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const mq = await import(`../src/message_queue.ts?case=notify-pop-${Date.now()}`);
    mq.enqueue({
      id: "om_test_2",
      chat_id: "oc_1",
      sender: "ou_user2",
      content: "部署生产环境",
      received_at: new Date().toISOString(),
      status: "pending",
    });

    const { popInboxCommand } = await import(`../src/notify.ts?case=pop-${Date.now()}`);
    const text = popInboxCommand();
    assert.ok(text.includes("部署生产环境"));
    assert.ok(text.includes("ou_user2"));
    assert.ok(text.includes("om_test_2"));
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
