import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HomeState = Record<
  string,
  { channelId: string; messageTs: string; pinnedMessageTs?: string }
>;

const HOME_PATH = join(process.cwd(), "data", "home-state.json");

export function readHomeState(): HomeState {
  try {
    const raw = readFileSync(HOME_PATH, "utf-8");
    return JSON.parse(raw) as HomeState;
  } catch {
    return {};
  }
}

export function writeHomeState(state: HomeState): void {
  mkdirSync(dirname(HOME_PATH), { recursive: true });
  writeFileSync(HOME_PATH, JSON.stringify(state, null, 2));
}

export function setHomeState(
  userId: string,
  channelId: string,
  messageTs: string,
  pinnedMessageTs?: string
): void {
  const state = readHomeState();
  state[userId] = { channelId, messageTs, pinnedMessageTs };
  writeHomeState(state);
}
