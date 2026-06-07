import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { config, projectRoot } from "../src/utils/config.js";

test("default runtime data directory is at project root data directory", () => {
  const root = resolve(".");

  assert.equal(projectRoot, root);
  assert.equal(config.dataDir, resolve(root, "data"));
  assert.equal(config.pidFile, resolve(root, "data/service.pid"));
  assert.equal(config.logFile, resolve(root, "data/service.log"));
});
