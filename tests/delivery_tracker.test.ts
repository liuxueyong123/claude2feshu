import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("recordDelivery stores msgId for a session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-tracker-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { recordDelivery, getLastDelivery } = await import(`../src/session/delivery.ts`);
    recordDelivery("sid-1", "om_msg_123");
    assert.equal(getLastDelivery("sid-1"), "om_msg_123");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("getLastDelivery returns null for unknown session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-tracker-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { getLastDelivery } = await import(`../src/session/delivery.ts`);
    assert.equal(getLastDelivery("unknown-sid"), null);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("clearDelivery removes session record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-tracker-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { recordDelivery, clearDelivery, getLastDelivery } = await import(`../src/session/delivery.ts`);
    recordDelivery("sid-1", "om_msg_456");
    assert.equal(getLastDelivery("sid-1"), "om_msg_456");
    clearDelivery("sid-1");
    assert.equal(getLastDelivery("sid-1"), null);
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recordDelivery overwrites previous delivery for same session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "c2f-tracker-"));
  const oldDir = process.env.FEISHU_DATA_DIR;
  process.env.FEISHU_DATA_DIR = dataDir;

  try {
    const { recordDelivery, getLastDelivery } = await import(`../src/session/delivery.ts`);
    recordDelivery("sid-1", "om_first");
    recordDelivery("sid-1", "om_second");
    assert.equal(getLastDelivery("sid-1"), "om_second");
  } finally {
    if (oldDir === undefined) delete process.env.FEISHU_DATA_DIR;
    else process.env.FEISHU_DATA_DIR = oldDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
