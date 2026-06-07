import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupLegacyDataDir,
  decideStartAction,
  resolveLegacyDataDir,
  resolveManagedPaths,
  resolveStopPid,
} from "../src/scripts/service.js";

test("start action is already-running when health check returns a live service", () => {
  const decision = decideStartAction({ ok: true, pid: 12345, port: 9876 });

  assert.deepEqual(decision, { action: "already-running", pid: 12345 });
});

test("start action spawns with append logging when no service is healthy", () => {
  const decision = decideStartAction(null);

  assert.deepEqual(decision, { action: "spawn", logMode: "append" });
});

test("stop pid falls back to health pid when pid file is missing", () => {
  assert.equal(resolveStopPid("", { ok: true, pid: 87941, port: 9876 }), 87941);
});

test("stop pid prefers health pid over a stale pid file", () => {
  assert.equal(resolveStopPid("11111", { ok: true, pid: 87941, port: 9876 }), 87941);
});

test("managed paths honor FEISHU_DATA_DIR", () => {
  const paths = resolveManagedPaths({ FEISHU_DATA_DIR: "/tmp/c2f-data" });

  assert.equal(paths.pidFile, "/tmp/c2f-data/service.pid");
  assert.equal(paths.logFile, "/tmp/c2f-data/service.log");
});

test("legacy data directory points at the old src/data location", () => {
  assert.equal(resolveLegacyDataDir("/repo/claude2feishu"), "/repo/claude2feishu/src/data");
});

test("cleanupLegacyDataDir removes the old src/data runtime directory", () => {
  const root = mkdtempSync(join(tmpdir(), "c2f-service-"));
  const legacyDir = join(root, "src/data");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "service.pid"), "12345", "utf-8");

  try {
    cleanupLegacyDataDir(root);
    assert.equal(existsSync(legacyDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package scripts use service manager instead of truncating service.log directly", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    scripts: Record<string, string>;
  };

  assert.equal(pkg.scripts.start, "npx tsx src/scripts/service.ts start");
  assert.equal(pkg.scripts.stop, "npx tsx src/scripts/service.ts stop");
  assert.equal(pkg.scripts.status, "npx tsx src/scripts/service.ts status");
  assert.equal(pkg.scripts.logs, "npx tsx src/scripts/service.ts logs");
  assert.equal(pkg.scripts.restart, "npx tsx src/scripts/service.ts restart");
});
