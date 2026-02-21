import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BriefHistoryEntry = {
  date: string;
  cards: Array<{ id: string; url: string; name: string }>;
  selected?: Array<{ id: string; url: string; name: string }>;
};

export type BriefHistory = Record<string, BriefHistoryEntry>;

const HISTORY_PATH = join(process.cwd(), "data", "brief-history.json");

export function readBriefHistory(): BriefHistory {
  try {
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    return JSON.parse(raw) as BriefHistory;
  } catch {
    return {};
  }
}

export function writeBriefHistory(history: BriefHistory): void {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

export function setBriefForUser(
  userId: string,
  entry: BriefHistoryEntry
): void {
  const history = readBriefHistory();
  history[userId] = entry;
  writeBriefHistory(history);
}

export function setBriefSelectionForUser(
  userId: string,
  selectedIds: string[]
): void {
  const history = readBriefHistory();
  const entry = history[userId];
  if (!entry) {
    return;
  }
  const selected = entry.cards.filter((card) => selectedIds.includes(card.id));
  history[userId] = { ...entry, selected };
  writeBriefHistory(history);
}
