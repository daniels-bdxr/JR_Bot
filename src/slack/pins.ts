import type { WebClient } from "@slack/web-api";

let pinsClient: WebClient | null = null;
let pinsScopeWarned = false;

export function setPinsClient(client: WebClient): void {
  pinsClient = client;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "unknown_error";
  }
  const maybe = error as { data?: { error?: string }; message?: string };
  if (maybe.data?.error) {
    return maybe.data.error;
  }
  if (maybe.message && maybe.message.includes("missing_scope")) {
    return "missing_scope";
  }
  return "unknown_error";
}

function warnMissingScopeOnce(): void {
  if (pinsScopeWarned) return;
  pinsScopeWarned = true;
  console.warn("Missing pins:write scope");
}

export async function pinMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  if (!pinsClient) {
    return;
  }
  try {
    await pinsClient.pins.add({ channel: channelId, timestamp: messageTs });
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "already_pinned") {
      return;
    }
    if (code === "missing_scope") {
      warnMissingScopeOnce();
      return;
    }
    console.warn(`pin_failed code=${code}`);
  }
}

export async function unpinMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  if (!pinsClient) {
    return;
  }
  try {
    await pinsClient.pins.remove({ channel: channelId, timestamp: messageTs });
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "not_pinned") {
      return;
    }
    if (code === "missing_scope") {
      warnMissingScopeOnce();
      return;
    }
    console.warn(`unpin_failed code=${code}`);
  }
}
