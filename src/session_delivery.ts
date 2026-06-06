import type { ClaudeState } from "./terminal.js";

export interface DeliveryMessage {
  id: string;
  content: string;
}

interface DeliveryDeps {
  getState: () => ClaudeState;
  send: (message: string, item: DeliveryMessage) => boolean;
  markDelivered: (id: string) => void;
  onDelivered?: (item: DeliveryMessage) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  postSendBusyWaitMs?: number;
  waitAfterLast?: boolean;
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  remaining: number;
  reason: "done" | "not_waiting" | "send_failed" | "session_did_not_start_processing";
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_WAIT_MS = 300_000;
const DEFAULT_POST_SEND_BUSY_WAIT_MS = 10_000;

export async function deliverMessagesSequentially(
  messages: DeliveryMessage[],
  deps: DeliveryDeps,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const postSendBusyWaitMs = options.postSendBusyWaitMs ?? DEFAULT_POST_SEND_BUSY_WAIT_MS;
  const waitAfterLast = options.waitAfterLast ?? false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let sent = 0;

  for (let i = 0; i < messages.length; i++) {
    const isReady = await waitForWaiting(deps.getState, sleep, pollIntervalMs, maxWaitMs);
    if (!isReady) return { sent, failed: 0, remaining: messages.length - i, reason: "not_waiting" };

    const item = messages[i];
    const ok = deps.send(item.content, item);
    if (!ok) return { sent, failed: 1, remaining: messages.length - i, reason: "send_failed" };

    deps.markDelivered(item.id);
    await deps.onDelivered?.(item);
    sent++;

    if (i < messages.length - 1 || waitAfterLast) {
      const startedProcessing = await waitUntilNotWaiting(deps.getState, sleep, pollIntervalMs, postSendBusyWaitMs);
      if (!startedProcessing) {
        return {
          sent,
          failed: 0,
          remaining: messages.length - i - 1,
          reason: "session_did_not_start_processing",
        };
      }
    }
  }

  return { sent, failed: 0, remaining: 0, reason: "done" };
}

async function waitForWaiting(
  getState: () => ClaudeState,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));
  for (let i = 0; i < attempts; i++) {
    const state = getState();
    if (state === "waiting") return true;
    if (state === "gone") return false;
    await sleep(pollIntervalMs);
  }
  return false;
}

async function waitUntilNotWaiting(
  getState: () => ClaudeState,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));
  for (let i = 0; i < attempts; i++) {
    if (getState() !== "waiting") return true;
    await sleep(pollIntervalMs);
  }
  return false;
}
