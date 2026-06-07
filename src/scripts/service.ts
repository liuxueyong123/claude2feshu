import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ServiceHealth {
  ok?: boolean;
  pid?: number;
  port?: number;
  [key: string]: unknown;
}

export interface ManagedPaths {
  dataDir: string;
  pidFile: string;
  logFile: string;
}

type ServiceEnv = Partial<Record<"FEISHU_DATA_DIR" | "FEISHU_NOTIFYD_PORT", string>>;

export type StartAction =
  | { action: "already-running"; pid: number }
  | { action: "spawn"; logMode: "append" };

export function resolveManagedPaths(
  env: ServiceEnv = process.env,
  cwd = process.cwd(),
): ManagedPaths {
  const dataDir = env.FEISHU_DATA_DIR || resolve(cwd, "data");
  return {
    dataDir,
    pidFile: resolve(dataDir, "service.pid"),
    logFile: resolve(dataDir, "service.log"),
  };
}

export function resolveLegacyDataDir(cwd = process.cwd()): string {
  return resolve(cwd, "src/data");
}

export function decideStartAction(health: ServiceHealth | null): StartAction {
  if (health?.ok === true && typeof health.pid === "number") {
    return { action: "already-running", pid: health.pid };
  }
  return { action: "spawn", logMode: "append" };
}

export function resolveStopPid(pidFileText: string, health: ServiceHealth | null): number | null {
  if (health?.ok === true && typeof health.pid === "number" && health.pid > 0) return health.pid;
  const pidFromFile = Number(pidFileText.trim());
  if (Number.isInteger(pidFromFile) && pidFromFile > 0) return pidFromFile;
  return null;
}

function resolvePort(env: ServiceEnv = process.env): number {
  const port = Number(env.FEISHU_NOTIFYD_PORT || "9876");
  return Number.isInteger(port) && port > 0 ? port : 9876;
}

function healthUrl(): string {
  return `http://127.0.0.1:${resolvePort()}/health`;
}

async function fetchHealth(): Promise<ServiceHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(healthUrl(), { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as ServiceHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function start(): Promise<number> {
  cleanupLegacyDataDir();

  const health = await fetchHealth();
  const decision = decideStartAction(health);
  if (decision.action === "already-running") {
    process.stdout.write(`already running pid=${decision.pid}\n`);
    if (health) printJson(health);
    return 0;
  }

  const paths = resolveManagedPaths();
  mkdirSync(paths.dataDir, { recursive: true });
  const logFd = openSync(paths.logFile, "a");
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  await sleep(2000);
  const nextHealth = await fetchHealth();
  if (nextHealth?.ok === true) {
    printJson(nextHealth);
    return 0;
  }

  process.stdout.write("(check status)\n");
  return 1;
}

async function stop(): Promise<number> {
  const paths = resolveManagedPaths();
  const pidFileText = existsSync(paths.pidFile) ? readFileSync(paths.pidFile, "utf-8") : "";
  const pid = resolveStopPid(pidFileText, await fetchHealth());
  if (!pid) {
    process.stdout.write("not running\n");
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
    await sleep(1000);
    cleanupLegacyDataDir();
    process.stdout.write(`stopped pid=${pid}\n`);
    if (existsSync(paths.pidFile)) unlinkSync(paths.pidFile);
    return 0;
  } catch (error) {
    process.stderr.write(`stop failed pid=${pid}: ${error}\n`);
    return 1;
  }
}

async function restart(): Promise<number> {
  const stopCode = await stop();
  if (stopCode !== 0) return stopCode;
  return start();
}

export function cleanupLegacyDataDir(cwd = process.cwd()): void {
  const legacyDir = resolveLegacyDataDir(cwd);
  const { dataDir } = resolveManagedPaths();
  if (legacyDir === dataDir || !existsSync(legacyDir)) return;
  rmSync(legacyDir, { recursive: true, force: true });
}

async function status(): Promise<number> {
  const health = await fetchHealth();
  if (!health) {
    process.stdout.write("not running\n");
    return 1;
  }
  printJson(health);
  return 0;
}

async function logs(): Promise<number> {
  const { logFile } = resolveManagedPaths();
  if (!existsSync(logFile)) {
    process.stdout.write(`log file not found: ${logFile}\n`);
    return 1;
  }

  const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });
  return await new Promise((resolveExit) => {
    tail.on("exit", (code) => resolveExit(code ?? 0));
    tail.on("error", (error) => {
      process.stderr.write(`tail failed: ${error}\n`);
      resolveExit(1);
    });
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "status";
  switch (command) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "status":
      return status();
    case "logs":
      return logs();
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
