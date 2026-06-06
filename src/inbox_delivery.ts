import type { InboxItem } from "./inbox.js";
import { deliverMessagesSequentially } from "./session_delivery.js";
import type { DeliveryOptions, DeliveryResult } from "./session_delivery.js";
import type { ClaudeState } from "./terminal.js";

interface InboxDeliveryDeps {
  getState: () => ClaudeState;
  send: (message: string, item: InboxItem) => boolean;
  markDone: (id: string, result?: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function deliverInboxPendingToTerminal(
  items: InboxItem[],
  deps: InboxDeliveryDeps,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  return deliverMessagesSequentially(
    items,
    {
      getState: deps.getState,
      send: (message, item) => deps.send(message, item as InboxItem),
      markDelivered: (id) => deps.markDone(id, "sent_to_terminal"),
      sleep: deps.sleep,
    },
    { ...options, waitAfterLast: options.waitAfterLast ?? true },
  );
}
