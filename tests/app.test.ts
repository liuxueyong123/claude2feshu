import test from "node:test";
import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createApp } from "../src/app.js";
import { config } from "../src/utils/config.js";

interface TestResponse {
  status: number;
  body: string;
}

async function request(
  path: string,
  init: RequestInit = {},
  logs: string[] = [],
): Promise<TestResponse> {
  const app = createApp({
    startedAt: Date.now(),
    logger: (msg) => logs.push(msg),
  });
  const callback = app.callback();
  const req = new PassThrough();
  const chunks: Buffer[] = [];
  const socket = new PassThrough();
  const body = typeof init.body === "string" ? init.body : "";
  const headers = Object.fromEntries(
    Object.entries(init.headers as Record<string, string> | undefined ?? {})
      .map(([key, value]) => [key.toLowerCase(), value]),
  );

  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = {
    ...headers,
    ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
  };

  const res = new ServerResponse(req);
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.assignSocket(socket);

  callback(req, res);
  req.end(body);
  await once(res, "finish");

  const raw = Buffer.concat(chunks).toString("utf-8");
  const [head, responseBody = ""] = raw.split("\r\n\r\n");
  const status = Number(head.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1] ?? 0);
  return { status, body: responseBody };
}

test("createApp exposes health without starting the service process", async () => {
  const response = await request("/health");
  const body = JSON.parse(response.body) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.port, config.port);
  assert.equal(body.bot, "stopped");
  assert.equal(body.pending, 0);
});

test("createApp returns a structured 400 for invalid JSON bodies", async () => {
  const logs: string[] = [];
  const response = await request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not valid json",
  }, logs);

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "invalid json" });
  assert.match(logs[0], /POST \/hook 400 \d+ms \d+b/);
});

test("createApp logs completed HTTP requests", async () => {
  const logs: string[] = [];
  const response = await request("/health", {}, logs);

  assert.equal(response.status, 200);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /GET \/health 200 \d+ms \d+b/);
});
