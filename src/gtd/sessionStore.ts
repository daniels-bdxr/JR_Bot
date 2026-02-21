import type { ClarifySuggestion } from "../ai/schemas";

export type ClarifyCardSummary = {
  id: string;
  name: string;
  desc: string;
  url: string;
};

export type ClarifySession = {
  userId: string;
  channelId: string;
  cards: ClarifyCardSummary[];
  index: number;
  state:
    | "review"
    | "boardSelect"
    | "actionable"
    | "project"
    | "nonActionable"
    | "summary"
    | "priority"
    | "energy"
    | "status"
    | "confirm";
  answers: Record<string, string>;
  messageTs?: string;
  nextActionText?: string;
  nextActionNotes?: string;
  projectName?: string;
  projectDescription?: string;
  priorityLabels?: string[];
  energyLabels?: string[];
  statusLabels?: string[];
  deadlineDate?: string;
  suggestion?: ClarifySuggestion;
  suggestionChoice?: "accept" | "edit" | "ignore";
  suggestionCardId?: string;
  aiInFlight?: boolean;
  aiRequestId?: string;
  lastActiveAt?: number;
  sessionMessageTs?: string;
  lastFiled?: {
    board: string;
    list: string;
    labels: string[];
  };
};

const sessions = new Map<string, ClarifySession>();
const SESSION_TTL_MS = 30 * 60 * 1000;

export type DoneSession = {
  userId: string;
  channelId: string;
  actionCardId: string;
  actionCardName: string;
  projectCardId: string;
  projectCardUrl: string;
  projectBoardId: string;
  checklistId: string;
  nextItemId?: string;
  nextItemName?: string;
  messageTs?: string;
  aiCandidates?: string[];
  aiRationale?: string;
  forceNewChecklistItem?: boolean;
  needsSuggestion?: boolean;
};

const doneSessions = new Map<string, DoneSession>();

export type ReviewSession = {
  userId: string;
  channelId: string;
  cards: Array<{ id: string; url: string }>;
  index: number;
  totalHours: number;
  doneCount: number;
  progressCount: number;
  blockedCount: number;
  noProgressCount: number;
  skipCount: number;
  pendingStatus?: "progress" | "blocked";
  messageTs?: string;
  awaitingNextAction?: boolean;
  suppressNextActionPrompt?: boolean;
};

const reviewSessions = new Map<string, ReviewSession>();

export function getSession(userId: string): ClarifySession | undefined {
  const session = sessions.get(userId);
  if (!session) {
    return undefined;
  }
  const lastActive = session.lastActiveAt ?? 0;
  if (Date.now() - lastActive > SESSION_TTL_MS) {
    sessions.delete(userId);
    return undefined;
  }
  return session;
}

export function setSession(session: ClarifySession): void {
  session.lastActiveAt = Date.now();
  sessions.set(session.userId, session);
}

export function clearSession(userId: string): void {
  sessions.delete(userId);
}

export function getDoneSession(userId: string): DoneSession | undefined {
  return doneSessions.get(userId);
}

export function setDoneSession(session: DoneSession): void {
  doneSessions.set(session.userId, session);
}

export function clearDoneSession(userId: string): void {
  doneSessions.delete(userId);
}

export function getReviewSession(userId: string): ReviewSession | undefined {
  return reviewSessions.get(userId);
}

export function setReviewSession(session: ReviewSession): void {
  reviewSessions.set(session.userId, session);
}

export function clearReviewSession(userId: string): void {
  reviewSessions.delete(userId);
}
