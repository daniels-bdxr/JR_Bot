import "dotenv/config";
import { App } from "@slack/bolt";
import type { Block, KnownBlock, ModalView } from "@slack/bolt";
import {
  renderClarifySession,
  renderReviewSession,
  updateSessionMessage,
} from "./slack/ui/sessionRenderer";
import { renderHomeScreen } from "./slack/ui/homeScreen";
import { readHomeState, setHomeState } from "./slack/ui/homeState";
import { pinMessage, setPinsClient, unpinMessage } from "./slack/pins";
import express from "express";
import { loadEnv } from "./env";
import { createTrelloClient } from "./trello/client";
import { getBoardByKey, loadBoardsConfig } from "./gtd/boards";
import {
  appendLogLine,
  appendOrReplaceFooter,
  buildFooter,
  parseFooter,
  FOOTER_MARKER,
} from "./gtd/footers";
import {
  clearDoneSession,
  clearSession,
  clearReviewSession,
  getDoneSession,
  getSession,
  getReviewSession,
  ReviewSession,
  setReviewSession,
  setDoneSession,
  setSession,
} from "./gtd/sessionStore";
import {
  readBriefHistory,
  setBriefForUser,
  setBriefSelectionForUser,
} from "./gtd/briefHistory";
import { generateStructured } from "./ai/structured";
import {
  ClarifySuggestionSchema,
  type ClarifySuggestion,
  ProjectNextActionSuggestionSchema,
  type ProjectNextActionSuggestion,
} from "./ai/schemas";
import { buildClarifyPrompt } from "./ai/prompts/clarifyPrompt";
import { buildProjectNextActionPrompt } from "./ai/prompts/projectNextActionPrompt";
import { getAiMetrics } from "./ai/metrics";
import { z } from "zod";

const env = loadEnv(process.env);
const boardsConfig = loadBoardsConfig();

const app = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  socketMode: true,
});

setPinsClient(app.client);

let reactionsScopeWarned = false;

const trello = createTrelloClient({
  apiKey: env.TRELLO_API_KEY,
  apiToken: env.TRELLO_API_TOKEN,
  inboxListId: env.TRELLO_INBOX_LIST_ID,
});

const server = express();
server.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function buildCardTitle(text: string): string {
  if (text.length <= 80) {
    return text;
  }
  return `${text.slice(0, 77)}...`;
}

function buildCardDescription(options: {
  userId: string;
  channelId: string;
  timestamp: string;
  text: string;
}): string {
  return options.text;
}

app.message(async ({ message, say }) => {
  if (message.channel_type !== "im") {
    return;
  }

  if (!("text" in message) || typeof message.text !== "string") {
    return;
  }

  if (!message.user) {
    return;
  }

  const timestamp = new Date().toISOString();
  const logPayload = {
    timestamp,
    userId: message.user,
    channelId: message.channel,
    text: message.text,
  };
  console.log(JSON.stringify(logPayload));

  try {
    const card = await trello.createInboxCard(
      buildCardTitle(message.text),
      buildCardDescription({
        userId: message.user,
        channelId: message.channel,
        timestamp,
        text: message.text,
      })
    );

    console.log(
      JSON.stringify({
        trelloCardId: card.id,
        trelloCardUrl: card.url,
      })
    );

    try {
      await app.client.reactions.add({
        channel: message.channel,
        name: "white_check_mark",
        timestamp: message.ts,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (!reactionsScopeWarned && errorMessage.includes("missing_scope")) {
        reactionsScopeWarned = true;
        console.warn("Missing reactions:write scope");
      }

      if (message.user) {
        await app.client.chat.postEphemeral({
          channel: message.channel,
          user: message.user,
          text: "✅ Captured to Trello Inbox",
        });
      }
    }
  } catch (error) {
    console.error(error);
    await say({
      text: "⚠️ Capture failed. Please try again.",
      thread_ts: message.ts,
    });
  }
});

app.command("/jrbot-verify", async ({ ack, respond }) => {
  await ack();

  const timestamp = new Date().toISOString();
  const title = `Verify Test - ${timestamp}`;

  try {
    const card = await trello.createInboxCard(title);
    await trello.deleteCard(card.id);

    await respond("ok: slack\nok: trello");
  } catch (error) {
    console.error(error);
    await respond("ok: slack\nerror: trello");
  }
});

app.command("/ai-status", async ({ ack, respond, command }) => {
  await ack();

  if (
    !command.channel_id.startsWith("D") &&
    command.channel_name !== "directmessage"
  ) {
    await respond("Please run /ai-status in a DM with me.");
    return;
  }

  const metrics = getAiMetrics();
  const recent = metrics.recent;
  let recentLine = "Last 20 calls: none yet";
  if (recent.length > 0) {
    const successCount = recent.filter((call) => call.ok).length;
    const avgLatency =
      Math.round(
        recent.reduce((sum, call) => sum + call.durationMs, 0) / recent.length
      ) || 0;
    const successRate = Math.round((successCount / recent.length) * 100);
    recentLine = `Last 20 calls: ${successRate}% success, avg ${avgLatency}ms`;
  }

  await respond(
    [
      `AI enabled: ${env.AI_ENABLED ? "true" : "false"}`,
      `Model: ${env.GEMINI_MODEL}`,
      recentLine,
    ].join("\n")
  );
});

app.command("/self-check", async ({ ack, respond, command, client }) => {
  await ack();

  if (
    !command.channel_id.startsWith("D") &&
    command.channel_name !== "directmessage"
  ) {
    await respond("Please run /self-check in a DM with me.");
    return;
  }

  const missingEnv: string[] = [];
  const requiredEnv = [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "TRELLO_API_KEY",
    "TRELLO_API_TOKEN",
    "TRELLO_INBOX_LIST_ID",
    "TRELLO_INBOX_RAW_LIST_ID",
    "TRELLO_INBOX_QUICK_LIST_ID",
    "TRELLO_INBOX_REFERENCE_LIST_ID",
    "GEMINI_API_KEY",
  ];
  for (const key of requiredEnv) {
    if (!process.env[key] || String(process.env[key]).trim().length === 0) {
      missingEnv.push(key);
    }
  }

  const lines: string[] = [];
  if (missingEnv.length > 0) {
    lines.push(`⚠️ Missing env vars: ${missingEnv.join(", ")}`);
  } else {
    lines.push("✅ Env vars present");
  }

  try {
    const cards = await trello.getCardsInList(env.TRELLO_INBOX_RAW_LIST_ID, {
      limit: 1,
    });
    lines.push(`✅ Trello reachable (Raw Inbox count: ${cards.length})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    lines.push(`⚠️ Trello error: ${message}`);
  }

  if (!env.AI_ENABLED) {
    lines.push("⚠️ AI disabled");
  } else {
    const testSchema = z.object({ ok: z.literal("OK") });
    const result = await generateStructured({
      system: "Return only JSON matching the schema.",
      user: "Return the JSON object {\"ok\":\"OK\"} only.",
      schema: testSchema,
      timeoutMs: 10000,
      maxRetries: 1,
    });
    if (result.ok) {
      lines.push("✅ Gemini structured test OK");
    } else {
      lines.push(`⚠️ Gemini error: ${result.error}`);
    }
  }

  await respond(lines.join("\n"));
});

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function getSuggestionBoardName(boardKey: string | null | undefined): string | null {
  if (!boardKey) {
    return null;
  }
  if (boardKey === "inbox_reference") {
    return "Inbox (Reference)";
  }
  const mappedKey =
    boardKey === "growth" ? "personal" : boardKey === "embxr" ? "ai_xr" : "bd_xr";
  const board = boardsConfig.boards.find((entry) => entry.key === mappedKey);
  return board ? board.name : null;
}

function getSuggestionTypeLabel(itemType: string | null | undefined): string | null {
  if (!itemType) {
    return null;
  }
  if (itemType === "action") return "Single Action";
  if (itemType === "project") return "Project";
  if (itemType === "reference") return "Reference";
  if (itemType === "someday") return "Someday";
  return null;
}

function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function mapSuggestionBoardKeyToSelection(
  boardKey?: string | null
): string | undefined {
  if (!boardKey) {
    return undefined;
  }
  if (boardKey === "growth") return "personal";
  if (boardKey === "embxr") return "ai_xr";
  if (boardKey === "bdxr") return "bd";
  if (boardKey === "inbox_reference") return "inbox_reference";
  return undefined;
}

function normalizePriorityLabel(label: string): string {
  if (label === "P1 – Focus") return "P1 - Focus";
  if (label === "P2 – Important") return "P2 - Important";
  if (label === "P3 – Backlog") return "P3 - Backlog";
  return label;
}

function normalizeEnergyLabel(label: string): string {
  if (label === "⚡ 5–10 min") return "⚡<30 min";
  return label;
}

function deriveClarifyDestination(session: {
  answers: Record<string, string>;
}): { boardName?: string; listName?: string; typeLabel?: string } {
  const boardSelection = session.answers.board;
  if (!boardSelection) {
    return {};
  }

  const actionable = session.answers.actionable;
  const projectType = session.answers.project;
  const nonActionable = session.answers.nonActionable;

  if (boardSelection === "inbox_reference") {
    if (actionable === "yes") {
      return {
        boardName: "Inbox",
        listName: "quick",
        typeLabel: "Single Action",
      };
    }
    return {
      boardName: "Inbox",
      listName: "reference",
      typeLabel: nonActionable === "maybe" ? "Someday" : "Reference",
    };
  }

  const mappedKey = mapBoardSelectionToKey(boardSelection);
  if (!mappedKey) {
    return {};
  }

  const boardConfig = getBoardByKey(boardsConfig, mappedKey);
  if (!boardConfig) {
    return {};
  }

  if (actionable === "yes") {
    if (projectType === "project") {
      return {
        boardName: boardConfig.name,
        listName: "projects",
        typeLabel: "Project",
      };
    }
    return {
      boardName: boardConfig.name,
      listName: "actionItems",
      typeLabel: "Single Action",
    };
  }

  if (nonActionable === "maybe") {
    return {
      boardName: boardConfig.name,
      listName: "maybeSomeday",
      typeLabel: "Someday",
    };
  }

  return {
    boardName: boardConfig.name,
    listName: "reference",
    typeLabel: "Reference",
  };
}

function buildClarifyBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string; desc: string };
}) {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Raw Inbox (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: truncate(
            options.card.desc && options.card.desc.trim().length > 0
              ? options.card.desc
              : "No description.",
            120
          ),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Process" },
          value: "process",
          action_id: "clarify_process",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          value: "skip",
          action_id: "clarify_skip",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          value: "stop",
          action_id: "clarify_stop",
          style: "danger",
        },
      ],
    },
  ];
}

async function getClarifySuggestion(options: {
  card: { name: string; desc: string };
  userId: string;
  channelId: string;
}): Promise<ClarifySuggestion | null> {
  const boards = boardsConfig.boards.map((board) => ({
    key: board.key === "personal" ? "growth" : board.key === "ai_xr" ? "embxr" : "bdxr",
    name: board.name,
  }));

  const { system, user } = buildClarifyPrompt({
    name: options.card.name,
    descSnippet: truncate(options.card.desc ?? "", 160),
    slack: { user: options.userId, channel: options.channelId, ts: undefined },
    boards,
    priorities: ["P1 – Focus", "P2 – Important", "P3 – Backlog"],
    energies: ["⚡ 5–10 min", "🧠 Deep", "🔋 Low Energy"],
    flags: ["⛔ Blocked", "🕒 Follow-up", "📅 Deadline"],
  });

  const result = await generateStructured<ClarifySuggestion>({
    system,
    user,
    schema: ClarifySuggestionSchema,
    timeoutMs: 5000,
    maxRetries: 0,
  });

  if (!result.ok) {
    return null;
  }

  return result.data;
}

function buildSessionExpiredBlocks(): Array<KnownBlock | Block> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Session expired. Run /clarify to start again.",
      },
    },
  ];
}

async function updateSessionExpiredFromAction(
  body: { channel?: { id?: string }; message?: { ts?: string } },
  client: App["client"]
) {
  const channelId = body.channel?.id;
  const ts = body.message?.ts;
  if (!channelId || !ts) {
    return;
  }
  await client.chat.update({
    channel: channelId,
    ts,
    text: "Session expired. Run /clarify to start again.",
    blocks: buildSessionExpiredBlocks(),
  });
}

function buildBoardSelectionBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
  suggestion?: ClarifySuggestion;
  suggestionChoice?: "accept" | "edit" | "ignore";
  showSuggesting?: boolean;
}) {
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Board (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
  ];

  if (options.showSuggesting) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "🤖 Suggesting…",
        },
      ],
    } as KnownBlock);
  }

  if (options.suggestion && options.suggestion.confidence >= 0.6) {
    const boardName = getSuggestionBoardName(options.suggestion.boardKey);
    const typeLabel = getSuggestionTypeLabel(options.suggestion.itemType);
    const labelParts = [
      options.suggestion.priority,
      options.suggestion.energy,
      ...(options.suggestion.flags ?? []),
    ].filter(isNonNull);
    const labels = labelParts.length > 0 ? labelParts.join(", ") : "None";
    const because = truncate(options.suggestion.rationale, 140);
    const nextAction = options.suggestion.nextAction
      ? `\nNext: ${truncate(options.suggestion.nextAction, 120)}`
      : "";
    const deadline = options.suggestion.deadline
      ? `\nDeadline: ${options.suggestion.deadline}`
      : "";

    blocks.push(
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Suggested filing*" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `Board: ${boardName ?? "Unclear"}`,
            `Type: ${typeLabel ?? "Unclear"}`,
            `Labels: ${labels}`,
            `Because: ${because}`,
          ]
            .join("\n")
            .concat(nextAction)
            .concat(deadline),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Accept" },
            value: "accept",
            action_id: "clarify_suggest_accept",
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Edit" },
            value: "edit",
            action_id: "clarify_suggest_edit",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Ignore" },
            value: "ignore",
            action_id: "clarify_suggest_ignore",
          },
        ],
      }
    );

    if (options.suggestionChoice) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Suggestion: ${options.suggestionChoice}`,
          },
        ],
      } as KnownBlock);
    }
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Which board does this belong to?",
    },
  });

  if (options.selected) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${options.selected}*`,
        },
      ],
    } as KnownBlock);
  }

  blocks.push(
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Personal" },
          value: "personal",
          action_id: "clarify_board_personal",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "AI+XR" },
          value: "ai_xr",
          action_id: "clarify_board_aixr",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "B&D" },
          value: "bd",
          action_id: "clarify_board_bd",
        },
      ],
    } as KnownBlock,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Stay in Inbox (Reference)" },
          value: "inbox_reference",
          action_id: "clarify_board_reference",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_back",
        },
      ],
    } as KnownBlock,
  );

  return blocks;
}

function buildActionableBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
}) {
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Actionable (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Is this actionable?" },
    },
  ];

  if (options.selected) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${options.selected}*`,
        },
      ],
    } as KnownBlock);
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Yes" },
        value: "yes",
        action_id: "clarify_actionable_yes",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "No" },
        value: "no",
        action_id: "clarify_actionable_no",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Back" },
        value: "back",
        action_id: "clarify_actionable_back",
      },
    ],
  } as KnownBlock);

  return blocks;
}

function buildNonActionableBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
}) {
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Non-Actionable (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Where should it go?" },
    },
  ];

  if (options.selected) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${options.selected}*`,
        },
      ],
    } as KnownBlock);
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Reference" },
        value: "reference",
        action_id: "clarify_nonaction_reference",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Maybe / Someday" },
        value: "maybe",
        action_id: "clarify_nonaction_maybe",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Back" },
        value: "back",
        action_id: "clarify_nonaction_back",
      },
    ],
  } as KnownBlock);

  return blocks;
}

function buildProjectBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
}) {
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Project (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Is this a project (more than one step)?",
      },
    },
  ];

  if (options.selected) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${options.selected}*`,
        },
      ],
    } as KnownBlock);
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Project" },
        value: "project",
        action_id: "clarify_project_project",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Single Action" },
        value: "single_action",
        action_id: "clarify_project_single",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Back" },
        value: "back",
        action_id: "clarify_project_back",
      },
    ],
  } as KnownBlock);

  return blocks;
}

function buildSummaryBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  board?: string;
  actionable?: string;
  typeLabel?: string;
  nextAction?: string;
}) {
  const lines = [
    `*Board:* ${options.board ?? "unknown"}`,
    `*Actionable:* ${options.actionable ?? "unknown"}`,
    `*Type:* ${options.typeLabel ?? "unknown"}`,
    `*Next Action:* ${options.nextAction ?? "unknown"}`,
  ];

  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Summary (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Continue" },
          value: "continue",
          action_id: "clarify_summary_continue",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_summary_back",
        },
      ],
    },
  ];

  return blocks;
}

function buildConfirmBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  boardName?: string;
  listName?: string;
  typeLabel?: string;
  projectName?: string;
  nextAction?: string;
  labels?: string[];
  deadline?: string;
}) {
  const labelText =
    options.labels && options.labels.length > 0 ? options.labels.join(", ") : "None";
  const lines = [
    `*Board:* ${options.boardName ?? "unknown"}`,
    `*List:* ${options.listName ?? "unknown"}`,
    `*Type:* ${options.typeLabel ?? "unknown"}`,
  ];

  if (options.typeLabel === "Project") {
    lines.push(`*Project:* ${options.projectName ?? "unknown"}`);
  }

  if (options.nextAction) {
    lines.push(`*Next Action:* ${options.nextAction}`);
  }

  lines.push(`*Labels:* ${labelText}`);
  lines.push(`*Deadline:* ${options.deadline ?? "None"}`);

  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Confirm (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Confirm filing*",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm" },
          value: "confirm",
          action_id: "clarify_confirm_commit",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_confirm_back",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          value: "cancel",
          action_id: "clarify_confirm_cancel",
        },
      ],
    },
  ];

  return blocks;
}

function buildPriorityBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
}) {
  const selected = options.selected?.join(", ") ?? "None";
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Priority (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Priority?" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${selected}*`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "P1 – Focus" },
          value: "p1_focus",
          action_id: "clarify_priority_p1",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "P2 – Important" },
          value: "p2_important",
          action_id: "clarify_priority_p2",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "P3 – Backlog" },
          value: "p3_backlog",
          action_id: "clarify_priority_p3",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "None" },
          value: "none",
          action_id: "clarify_priority_none",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_priority_back",
        },
      ],
    },
  ];

  return blocks;
}

function buildEnergyBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
}) {
  const selected = options.selected?.join(", ") ?? "None";
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Energy/Time (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Energy/Time?" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${selected}*`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "⚡<30 min" },
          value: "quick",
          action_id: "clarify_energy_quick",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🧠 Deep" },
          value: "deep",
          action_id: "clarify_energy_deep",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🔋 Low Energy" },
          value: "low",
          action_id: "clarify_energy_low",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "None" },
          value: "none",
          action_id: "clarify_energy_none",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_energy_back",
        },
      ],
    },
  ];

  return blocks;
}

function buildStatusBlocks(options: {
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
  deadlineDate?: string;
}) {
  const selected =
    options.selected && options.selected.length > 0
      ? options.selected.join(", ")
      : "None";
  const deadlineText = options.deadlineDate
    ? ` • Deadline: ${options.deadlineDate}`
    : "";
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Clarify — Status Flags (${options.index} of ${options.total})`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${options.card.name}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Status flags?" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Selected: *${selected}*${deadlineText}`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "⛔ Blocked" },
          value: "blocked",
          action_id: "clarify_status_blocked",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🕒 Follow-up" },
          value: "followup",
          action_id: "clarify_status_followup",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📅 Deadline" },
          value: "deadline",
          action_id: "clarify_status_deadline",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "None" },
          value: "none",
          action_id: "clarify_status_none",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Back" },
          value: "back",
          action_id: "clarify_status_back",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Commit" },
          value: "commit",
          action_id: "clarify_commit",
          style: "primary",
        },
      ],
    },
  ];

  return blocks;
}

async function postClarifyCard(options: {
  channelId: string;
  index: number;
  total: number;
  card: { name: string; url: string; desc: string };
  client: App["client"];
  lastFiled?: { board: string; list: string; labels: string[] };
}): Promise<string> {
  const response = await options.client.chat.postMessage({
    channel: options.channelId,
    text: `Clarify — Raw Inbox (${options.index} of ${options.total})`,
    blocks: renderClarifySession({
      blocks: buildClarifyBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
      }),
      lastFiled: options.lastFiled,
    }),
  });
  return response.ts as string;
}

async function updateClarifyCard(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string; desc: string };
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildClarifyBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Raw Inbox (${options.index} of ${options.total})`
  );
}

async function updateBoardSelection(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
  suggestion?: ClarifySuggestion;
  suggestionChoice?: "accept" | "edit" | "ignore";
  showSuggesting?: boolean;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildBoardSelectionBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
        suggestion: options.suggestion,
        suggestionChoice: options.suggestionChoice,
        showSuggesting: options.showSuggesting,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Board (${options.index} of ${options.total})`
  );
}

async function updateActionable(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildActionableBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Actionable (${options.index} of ${options.total})`
  );
}

async function updateNonActionable(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildNonActionableBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Non-Actionable (${options.index} of ${options.total})`
  );
}

async function updateProject(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildProjectBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Project (${options.index} of ${options.total})`
  );
}

async function updateSummary(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  board?: string;
  actionable?: string;
  typeLabel?: string;
  nextAction?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildSummaryBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        board: options.board,
        actionable: options.actionable,
        typeLabel: options.typeLabel,
        nextAction: options.nextAction,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Summary (${options.index} of ${options.total})`
  );
}

async function updateConfirm(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  boardName?: string;
  listName?: string;
  typeLabel?: string;
  projectName?: string;
  nextAction?: string;
  labels?: string[];
  deadline?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildConfirmBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        boardName: options.boardName,
        listName: options.listName,
        typeLabel: options.typeLabel,
        projectName: options.projectName,
        nextAction: options.nextAction,
        labels: options.labels,
        deadline: options.deadline,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Confirm (${options.index} of ${options.total})`
  );
}

async function updatePriority(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildPriorityBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Priority (${options.index} of ${options.total})`
  );
}

async function updateEnergy(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildEnergyBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Energy/Time (${options.index} of ${options.total})`
  );
}

async function updateStatus(options: {
  channelId: string;
  messageTs: string;
  index: number;
  total: number;
  card: { name: string; url: string };
  selected?: string[];
  deadlineDate?: string;
  lastFiled?: { board: string; list: string; labels: string[] };
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderClarifySession({
      blocks: buildStatusBlocks({
        index: options.index,
        total: options.total,
        card: options.card,
        selected: options.selected,
        deadlineDate: options.deadlineDate,
      }),
      lastFiled: options.lastFiled,
    }),
    `Clarify — Status Flags (${options.index} of ${options.total})`
  );
}

async function startClarify(options: {
  userId: string;
  channelId: string;
  channelName?: string;
  client: App["client"];
  respond?: (text: string) => Promise<void>;
}) {
  const existing = getSession(options.userId);
  if (existing) {
    if (!existing.sessionMessageTs) {
      const messageTs = await postClarifyCard({
        channelId: existing.channelId,
        index: existing.index + 1,
        total: existing.cards.length,
        card: existing.cards[existing.index],
        client: options.client,
        lastFiled: existing.lastFiled,
      });
      existing.sessionMessageTs = messageTs;
      setSession(existing);
    }

    if (existing.state === "review") {
      await updateClarifyCard({
        channelId: existing.channelId,
        messageTs: existing.sessionMessageTs,
        index: existing.index + 1,
        total: existing.cards.length,
        card: existing.cards[existing.index],
        lastFiled: existing.lastFiled,
        client: options.client,
      });
      if (options.respond) {
        await options.respond("Resumed clarify session.");
      }
      return;
    }

    await handleStepNavigation(
      { user: { id: options.userId }, channel: { id: existing.channelId } },
      options.client,
      existing.state
    );
    if (options.respond) {
      await options.respond("Resumed clarify session.");
    }
    return;
  }

  const cards = await trello.getCardsInList(env.TRELLO_INBOX_RAW_LIST_ID, {
    limit: 10,
  });

  if (cards.length === 0) {
    if (options.respond) {
      await options.respond("Inbox is empty ✅");
    }
    return;
  }

  setSession({
    userId: options.userId,
    channelId: options.channelId,
    cards,
    index: 0,
    state: "review",
    answers: {},
    priorityLabels: [],
    energyLabels: [],
    statusLabels: [],
  });

  const messageTs = await postClarifyCard({
    channelId: options.channelId,
    index: 1,
    total: cards.length,
    card: cards[0],
    client: options.client,
    lastFiled: undefined,
  });
  const session = getSession(options.userId);
  if (session) {
    session.sessionMessageTs = messageTs;
    setSession(session);
  }
}

app.command("/clarify", async ({ ack, respond, command, client }) => {
  await ack();

  const subcommand = command.text.trim().toLowerCase();
  if (subcommand === "stop") {
    const existingStop = getSession(command.user_id);
    if (existingStop?.sessionMessageTs) {
      await client.chat.update({
        channel: existingStop.channelId,
        ts: existingStop.sessionMessageTs,
        text: "Clarify session stopped.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Clarify session stopped." },
          },
        ],
      });
    }
    clearSession(command.user_id);
    await respond("Clarify session stopped.");
    return;
  }

  if (
    !command.channel_id.startsWith("D") &&
    command.channel_name !== "directmessage"
  ) {
    await respond("Please run /clarify in a DM with me.");
    return;
  }

  await startClarify({
    userId: command.user_id,
    channelId: command.channel_id,
    channelName: command.channel_name,
    client,
    respond,
  });
});

app.action("clarify_process", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  if (!env.AI_ENABLED) {
    session.aiInFlight = false;
    session.aiRequestId = undefined;
    setSession(session);
    await handleStepNavigation(body, client, "boardSelect");
    return;
  }

  if (session.aiInFlight) {
    await client.chat.postEphemeral({
      channel: session.channelId,
      user: session.userId,
      text: "Already generating suggestions…",
    });
    return;
  }

  const currentCard = session.cards[session.index];
  if (session.suggestionCardId !== currentCard.id) {
    session.suggestionCardId = currentCard.id;
    session.suggestion = undefined;
    session.suggestionChoice = undefined;
  }

  if (!session.suggestion) {
    session.aiInFlight = true;
    session.aiRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSession(session);

    if (session.sessionMessageTs) {
      await updateBoardSelection({
        channelId: session.channelId,
        messageTs: session.sessionMessageTs,
        index: session.index + 1,
        total: session.cards.length,
        card: currentCard,
        selected: session.answers.board,
        suggestion: session.suggestion,
        suggestionChoice: session.suggestionChoice,
        showSuggesting: true,
        lastFiled: session.lastFiled,
        client,
      });
    }

    const suggestion = await getClarifySuggestion({
      card: { name: currentCard.name, desc: currentCard.desc },
      userId: session.userId,
      channelId: session.channelId,
    });

    const latest = getSession(userId);
    if (!latest || latest.channelId !== body.channel?.id) {
      return;
    }

    if (latest.suggestionCardId === currentCard.id && suggestion) {
      latest.suggestion = suggestion;
    }
    latest.aiInFlight = false;
    latest.aiRequestId = undefined;
    setSession(latest);
  }

  await handleStepNavigation(body, client, "boardSelect");
});

async function handleSuggestionChoice(
  choice: "accept" | "edit" | "ignore",
  body: { user: { id: string }; channel?: { id?: string } },
  client: App["client"]
) {
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  if (choice === "ignore") {
    session.suggestionChoice = "ignore";
    session.answers = {};
    session.priorityLabels = [];
    session.energyLabels = [];
    session.statusLabels = [];
    session.deadlineDate = undefined;
    session.nextActionText = undefined;
    session.nextActionNotes = undefined;
    session.projectName = undefined;
    session.projectDescription = undefined;
    setSession(session);
    await handleStepNavigation(body, client, "boardSelect");
    return;
  }

  const suggestion = session.suggestion;
  if (!suggestion) {
    session.suggestionChoice = choice;
    setSession(session);
    await handleStepNavigation(body, client, "boardSelect");
    return;
  }

  session.answers = {};
  session.priorityLabels = [];
  session.energyLabels = [];
  session.statusLabels = [];
  session.deadlineDate = undefined;
  session.nextActionText = undefined;
  session.nextActionNotes = undefined;
  session.projectName = undefined;
  session.projectDescription = undefined;

  const boardSelection = mapSuggestionBoardKeyToSelection(suggestion.boardKey);
  if (boardSelection) {
    session.answers.board = boardSelection;
  }

  if (suggestion.itemType === "action") {
    session.answers.actionable = "yes";
    session.answers.project = "single_action";
  } else if (suggestion.itemType === "project") {
    session.answers.actionable = "yes";
    session.answers.project = "project";
    if (!session.projectName) {
      session.projectName = session.cards[session.index].name;
    }
  } else if (suggestion.itemType === "reference") {
    session.answers.actionable = "no";
    session.answers.nonActionable = "reference";
  } else if (suggestion.itemType === "someday") {
    session.answers.actionable = "no";
    session.answers.nonActionable = "maybe";
  }

  session.priorityLabels = suggestion.priority
    ? [normalizePriorityLabel(suggestion.priority)]
    : [];
  session.energyLabels = suggestion.energy
    ? [normalizeEnergyLabel(suggestion.energy)]
    : [];
  session.statusLabels = suggestion.flags ?? [];
  session.deadlineDate = suggestion.deadline ?? undefined;

  if (choice === "edit") {
    session.suggestionChoice = "edit";
    setSession(session);
    await handleStepNavigation(body, client, "boardSelect");
    return;
  }

  session.suggestionChoice = "accept";

  const requiresBoardOrType =
    !session.answers.board || !session.answers.actionable;
  if (requiresBoardOrType) {
    setSession(session);
    await handleStepNavigation(body, client, "boardSelect");
    return;
  }

  if (session.answers.actionable === "yes") {
    if (!session.nextActionText && suggestion.nextAction) {
      session.nextActionText = suggestion.nextAction;
    }
    if (!session.nextActionText || session.nextActionText.trim().length === 0) {
      session.state = "confirm";
      setSession(session);
      if ("trigger_id" in body && typeof body.trigger_id === "string") {
        await openNextActionModal({ triggerId: body.trigger_id, client });
        return;
      }
    }
  }

  const needsDeadline =
    session.statusLabels?.includes("📅 Deadline") && !session.deadlineDate;
  if (needsDeadline) {
    session.state = "confirm";
    setSession(session);
    if ("trigger_id" in body && typeof body.trigger_id === "string") {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: "clarify_deadline_modal",
          title: { type: "plain_text", text: "Deadline" },
          submit: { type: "plain_text", text: "Save" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "deadline_block",
              label: { type: "plain_text", text: "Deadline (YYYY-MM-DD)" },
              element: {
                type: "plain_text_input",
                action_id: "deadline_input",
                placeholder: { type: "plain_text", text: "2026-02-28" },
              },
            },
          ],
        },
      });
      return;
    }
  }

  session.state = "confirm";
  setSession(session);
  await handleStepNavigation(body, client, "confirm");
}

app.action("clarify_suggest_accept", async ({ ack, body, client }) => {
  await ack();
  await handleSuggestionChoice("accept", body, client);
});

app.action("clarify_suggest_edit", async ({ ack, body, client }) => {
  await ack();
  await handleSuggestionChoice("edit", body, client);
});

app.action("clarify_suggest_ignore", async ({ ack, body, client }) => {
  await ack();
  await handleSuggestionChoice("ignore", body, client);
});

app.action("clarify_skip", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  const nextIndex = session.index + 1;
  if (nextIndex >= session.cards.length) {
    clearSession(userId);
    if (session.sessionMessageTs) {
      await client.chat.update({
        channel: session.channelId,
        ts: session.sessionMessageTs,
        text: "Clarify session complete ✅",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Clarify session complete ✅" },
          },
        ],
      });
    }
    return;
  }

  if (!session.sessionMessageTs) {
    const messageTs = await postClarifyCard({
      channelId: session.channelId,
      index: nextIndex + 1,
      total: session.cards.length,
      card: session.cards[nextIndex],
      client,
      lastFiled: session.lastFiled,
    });
    session.sessionMessageTs = messageTs;
  } else {
    await updateClarifyCard({
      channelId: session.channelId,
      messageTs: session.sessionMessageTs,
      index: nextIndex + 1,
      total: session.cards.length,
      card: session.cards[nextIndex],
      lastFiled: session.lastFiled,
      client,
    });
  }

  session.index = nextIndex;
  session.state = "review";
  session.answers = {};
  session.suggestion = undefined;
  session.suggestionChoice = undefined;
  session.suggestionCardId = undefined;
  setSession(session);
});

app.action("clarify_stop", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (session?.sessionMessageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.sessionMessageTs,
      text: "Clarify session stopped.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Clarify session stopped." },
        },
      ],
    });
  }
  clearSession(userId);
});

async function handleBoardSelection(
  boardKey: string,
  body: { user: { id: string }; channel?: { id?: string } },
  client: App["client"]
) {
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.answers = { ...session.answers, board: boardKey };
  setSession(session);

  await handleStepNavigation(body, client, "actionable");
}

async function handleStepNavigation(
  body: { user: { id: string }; channel?: { id?: string } },
  client: App["client"],
  state:
    | "boardSelect"
    | "actionable"
    | "nonActionable"
    | "project"
    | "summary"
    | "priority"
    | "energy"
    | "status"
    | "confirm"
) {
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  if (!session.sessionMessageTs) {
    const messageTs = await postClarifyCard({
      channelId: session.channelId,
      index: session.index + 1,
      total: session.cards.length,
      card: session.cards[session.index],
      client,
      lastFiled: session.lastFiled,
    });
    session.sessionMessageTs = messageTs;
    setSession(session);
  }

  session.state = state;
  setSession(session);

  const common = {
    channelId: session.channelId,
    messageTs: session.sessionMessageTs,
    index: session.index + 1,
    total: session.cards.length,
    card: session.cards[session.index],
    client,
    lastFiled: session.lastFiled,
  };

  if (state === "boardSelect") {
    await updateBoardSelection({
      ...common,
      selected: session.answers.board,
      suggestion: session.suggestion,
      suggestionChoice: session.suggestionChoice,
      showSuggesting: session.aiInFlight,
    });
    return;
  }

  if (state === "actionable") {
    await updateActionable({
      ...common,
      selected: session.answers.actionable,
    });
    return;
  }

  if (state === "nonActionable") {
    await updateNonActionable({
      ...common,
      selected: session.answers.nonActionable,
    });
    return;
  }

  if (state === "project") {
    await updateProject({
      ...common,
      selected: session.answers.project,
    });
    return;
  }

  if (state === "summary") {
    const typeLabel =
      session.answers.actionable === "yes"
        ? session.answers.project === "project"
          ? "Project"
          : "Single Action"
        : session.answers.nonActionable === "maybe"
          ? "Someday"
          : "Reference";
    await updateSummary({
      ...common,
      board: session.answers.board,
      actionable: session.answers.actionable,
      typeLabel,
      nextAction: session.nextActionText,
    });
    return;
  }

  if (state === "confirm") {
    const destination = deriveClarifyDestination(session);
    const labels = [
      ...(session.priorityLabels ?? []),
      ...(session.energyLabels ?? []),
      ...(session.statusLabels ?? []),
    ];
    await updateConfirm({
      ...common,
      boardName: destination.boardName,
      listName: destination.listName,
      typeLabel: destination.typeLabel,
      projectName: session.projectName ?? session.cards[session.index].name,
      nextAction: session.nextActionText,
      labels,
      deadline: session.deadlineDate,
    });
    return;
  }

  if (state === "priority") {
    await updatePriority({
      ...common,
      selected: session.priorityLabels,
    });
    return;
  }

  if (state === "energy") {
    await updateEnergy({
      ...common,
      selected: session.energyLabels,
    });
    return;
  }

  await updateStatus({
    ...common,
    selected: session.statusLabels,
    deadlineDate: session.deadlineDate,
  });
}

async function openNextActionModal(options: {
  triggerId: string;
  client: App["client"];
}) {
  await options.client.views.open({
    trigger_id: options.triggerId,
    view: buildNextActionModalView(),
  });
}

function buildNextActionModalView(): ModalView {
  return {
    type: "modal",
    callback_id: "clarify_next_action_modal",
    title: {
      type: "plain_text",
      text: "Next Action",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "next_action_block",
        label: {
          type: "plain_text",
          text: "Next Action",
        },
        element: {
          type: "plain_text_input",
          action_id: "next_action_input",
        },
      },
      {
        type: "input",
        block_id: "notes_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Notes",
        },
        element: {
          type: "plain_text_input",
          action_id: "notes_input",
          multiline: true,
        },
      },
    ],
  };
}

function buildProjectDetailsModalView(): ModalView {
  return {
    type: "modal",
    callback_id: "clarify_project_details_modal",
    title: {
      type: "plain_text",
      text: "Project Details",
    },
    submit: {
      type: "plain_text",
      text: "Next",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "project_name_block",
        label: {
          type: "plain_text",
          text: "Project Name",
        },
        element: {
          type: "plain_text_input",
          action_id: "project_name_input",
        },
      },
      {
        type: "input",
        block_id: "project_desc_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Project Description",
        },
        element: {
          type: "plain_text_input",
          action_id: "project_desc_input",
          multiline: true,
        },
      },
    ],
  };
}

app.action("clarify_board_personal", async ({ ack, body, client }) => {
  await ack();
  await handleBoardSelection("personal", body, client);
});

app.action("clarify_board_aixr", async ({ ack, body, client }) => {
  await ack();
  await handleBoardSelection("ai_xr", body, client);
});

app.action("clarify_board_bd", async ({ ack, body, client }) => {
  await ack();
  await handleBoardSelection("bd", body, client);
});

app.action("clarify_board_reference", async ({ ack, body, client }) => {
  await ack();
  await handleBoardSelection("inbox_reference", body, client);
});

app.action("clarify_back", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  if (!session.sessionMessageTs) {
    const messageTs = await postClarifyCard({
      channelId: session.channelId,
      index: session.index + 1,
      total: session.cards.length,
      card: session.cards[session.index],
      client,
      lastFiled: session.lastFiled,
    });
    session.sessionMessageTs = messageTs;
    setSession(session);
    return;
  }

  session.state = "review";
  setSession(session);

  await updateClarifyCard({
    channelId: session.channelId,
    messageTs: session.sessionMessageTs,
    index: session.index + 1,
    total: session.cards.length,
    card: session.cards[session.index],
    lastFiled: session.lastFiled,
    client,
  });
});

app.action("clarify_actionable_yes", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.state = "project";
  session.answers = { ...session.answers, actionable: "yes" };
  setSession(session);
  await handleStepNavigation(body, client, "project");
});

app.action("clarify_actionable_no", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.state = "nonActionable";
  session.answers = { ...session.answers, actionable: "no" };
  setSession(session);
  await handleStepNavigation(body, client, "nonActionable");
});

app.action("clarify_actionable_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "boardSelect");
});

app.action("clarify_nonaction_reference", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.answers = { ...session.answers, nonActionable: "reference" };
  setSession(session);
  await handleStepNavigation(body, client, "summary");
});

app.action("clarify_nonaction_maybe", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.answers = { ...session.answers, nonActionable: "maybe" };
  setSession(session);
  await handleStepNavigation(body, client, "summary");
});

app.action("clarify_nonaction_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "actionable");
});

app.action("clarify_project_project", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.answers = { ...session.answers, project: "project" };
  setSession(session);
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildProjectDetailsModalView(),
    });
  }
});

app.action("clarify_project_single", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.answers = { ...session.answers, project: "single_action" };
  setSession(session);
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await openNextActionModal({ triggerId: body.trigger_id, client });
  }
});

app.action("clarify_project_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "actionable");
});

app.view("clarify_next_action_modal", async ({ ack, body, view, client }) => {
  const nextAction =
    view.state.values["next_action_block"]?.["next_action_input"]?.value ?? "";
  if (nextAction.trim().length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        next_action_block: "Next action is required.",
      },
    });
    return;
  }

  await ack({ response_action: "clear" });

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || !session.sessionMessageTs) {
    return;
  }

  const notes =
    view.state.values["notes_block"]?.["notes_input"]?.value ?? "";

  session.nextActionText = nextAction;
  session.nextActionNotes = notes;
  if (session.state === "confirm") {
    setSession(session);
    await handleStepNavigation(
      { user: { id: session.userId }, channel: { id: session.channelId } },
      client,
      "confirm"
    );
    return;
  }

  session.state = "summary";
  setSession(session);

  await updateSummary({
    channelId: session.channelId,
    messageTs: session.sessionMessageTs,
    index: session.index + 1,
    total: session.cards.length,
    card: session.cards[session.index],
    board: session.answers.board,
    actionable: session.answers.actionable,
    typeLabel:
      session.answers.actionable === "yes"
        ? session.answers.project === "project"
          ? "Project"
          : "Single Action"
        : session.answers.nonActionable === "maybe"
          ? "Someday"
          : "Reference",
    nextAction: session.nextActionText,
    lastFiled: session.lastFiled,
    client,
  });
});

app.view("clarify_project_details_modal", async ({ ack, body, view }) => {
  const projectName =
    view.state.values["project_name_block"]?.["project_name_input"]?.value ?? "";
  if (projectName.trim().length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        project_name_block: "Project name is required.",
      },
    });
    return;
  }

  await ack({
    response_action: "push",
    view: buildNextActionModalView(),
  });

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session) {
    return;
  }

  const projectDescription =
    view.state.values["project_desc_block"]?.["project_desc_input"]?.value ?? "";

  session.projectName = projectName.trim();
  session.projectDescription = projectDescription;
  setSession(session);
});

app.action("clarify_summary_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "project");
});

app.action("clarify_summary_continue", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "priority");
});

function setSingleLabel(
  current: string[] | undefined,
  value: string,
  noneValue = "none"
): string[] {
  if (value === noneValue) {
    return [];
  }
  return [value];
}

app.action("clarify_priority_p1", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.priorityLabels = setSingleLabel(session.priorityLabels, "P1 - Focus");
  setSession(session);
  await handleStepNavigation(body, client, "energy");
});

app.action("clarify_priority_p2", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.priorityLabels = setSingleLabel(
    session.priorityLabels,
    "P2 - Important"
  );
  setSession(session);
  await handleStepNavigation(body, client, "energy");
});

app.action("clarify_priority_p3", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.priorityLabels = setSingleLabel(
    session.priorityLabels,
    "P3 - Backlog"
  );
  setSession(session);
  await handleStepNavigation(body, client, "energy");
});

app.action("clarify_priority_none", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.priorityLabels = [];
  setSession(session);
  await handleStepNavigation(body, client, "energy");
});

app.action("clarify_priority_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "summary");
});

app.action("clarify_energy_quick", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.energyLabels = setSingleLabel(session.energyLabels, "⚡<30 min");
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_energy_deep", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.energyLabels = setSingleLabel(session.energyLabels, "🧠 Deep");
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_energy_low", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.energyLabels = setSingleLabel(session.energyLabels, "🔋 Low Energy");
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_energy_none", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.energyLabels = [];
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_energy_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "priority");
});

app.action("clarify_status_blocked", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.statusLabels = setSingleLabel(session.statusLabels, "⛔ Blocked");
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_status_followup", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.statusLabels = setSingleLabel(session.statusLabels, "🕒 Follow-up");
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_status_deadline", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "clarify_deadline_modal",
        title: { type: "plain_text", text: "Deadline" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "deadline_block",
            label: { type: "plain_text", text: "Deadline (YYYY-MM-DD)" },
            element: {
              type: "plain_text_input",
              action_id: "deadline_input",
              placeholder: { type: "plain_text", text: "2026-02-28" },
            },
          },
        ],
      },
    });
  }
});

app.action("clarify_status_none", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.statusLabels = [];
  session.deadlineDate = undefined;
  setSession(session);
  await handleStepNavigation(body, client, "status");
});

app.action("clarify_status_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "energy");
});

app.view("clarify_deadline_modal", async ({ ack, body, view, client }) => {
  await ack();

  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || !session.sessionMessageTs) {
    return;
  }

  const deadline =
    view.state.values["deadline_block"]?.["deadline_input"]?.value ?? "";
  session.deadlineDate = deadline;
  session.statusLabels = setSingleLabel(
    session.statusLabels,
    "📅 Deadline"
  );
  setSession(session);

  if (session.state === "confirm") {
    await handleStepNavigation(
      { user: { id: session.userId }, channel: { id: session.channelId } },
      client,
      "confirm"
    );
    return;
  }

  await updateStatus({
    channelId: session.channelId,
    messageTs: session.sessionMessageTs,
    index: session.index + 1,
    total: session.cards.length,
    card: session.cards[session.index],
    selected: session.statusLabels,
    deadlineDate: session.deadlineDate,
    lastFiled: session.lastFiled,
    client,
  });
});

function mapBoardSelectionToKey(selection?: string): string | undefined {
  if (!selection) {
    return undefined;
  }
  if (selection === "personal") {
    return "personal";
  }
  if (selection === "ai_xr") {
    return "ai_xr";
  }
  if (selection === "bd") {
    return "bd_xr";
  }
  return undefined;
}

function mapBoardKeyToFooterBoard(
  boardKey: string
): "growth" | "embxr" | "bdxr" {
  if (boardKey === "personal") {
    return "growth";
  }
  if (boardKey === "ai_xr") {
    return "embxr";
  }
  return "bdxr";
}

function findBoardById(boardId: string) {
  return boardsConfig.boards.find((board) => board.boardId === boardId);
}

function parseTrelloCardIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const cIndex = parts.indexOf("c");
    if (cIndex >= 0 && parts[cIndex + 1]) {
      return parts[cIndex + 1];
    }
    return null;
  } catch {
    return null;
  }
}

function findNextChecklistItem(
  items: Array<{ id: string; name: string; state: "complete" | "incomplete" }>,
  currentActionName: string
) {
  const normalized = currentActionName.trim().toLowerCase();
  const nextItem = items.find((item) => {
    if (item.state !== "incomplete") {
      return false;
    }
    return true;
  });
  const currentMatch = items.find((item) => {
    if (!item.name.startsWith("[NEXT]")) {
      return false;
    }
    return item.name.toLowerCase().includes(normalized);
  });
  return { nextItem, currentMatch };
}

function ensureNextPrefix(name: string): string {
  if (name.startsWith("[NEXT]")) {
    return name;
  }
  return `[NEXT] ${name}`;
}

function updateProjectFooter(desc: string, options: {
  boardKey: string;
  links?: { projectCardUrl?: string; actionCardUrl?: string };
  logLine?: string;
}): string {
  const existing = parseFooter(desc);
  const log = [...(existing?.log ?? [])];
  if (options.logLine) {
    log.push(options.logLine);
  }

  const footer = buildFooter({
    type: existing?.type ?? "project",
    board: existing?.board ?? mapBoardKeyToFooterBoard(options.boardKey),
    list: existing?.list ?? "projects",
    links: { ...existing?.links, ...options.links },
    slack: existing?.slack,
    log,
    total_hours: existing?.total_hours,
  });

  return appendOrReplaceFooter(desc, footer);
}

function updateProjectFooterWithHours(options: {
  desc: string;
  boardKey: string;
  logLine: string;
  hours: number;
}): string {
  const existing = parseFooter(options.desc);
  const current = existing?.total_hours ?? 0;
  const nextTotal = Math.round((current + options.hours) * 100) / 100;
  const log = [...(existing?.log ?? []), options.logLine];
  const footer = buildFooter({
    type: existing?.type ?? "project",
    board: existing?.board ?? mapBoardKeyToFooterBoard(options.boardKey),
    list: existing?.list ?? "projects",
    links: existing?.links,
    slack: existing?.slack,
    log,
    total_hours: nextTotal,
  });
  return appendOrReplaceFooter(options.desc, footer);
}

function stripFooter(desc: string): string {
  const markerIndex = desc.indexOf(FOOTER_MARKER);
  if (markerIndex < 0) {
    return desc.trim();
  }
  return desc.slice(0, markerIndex).trim();
}

function buildAiNextActionBlocks(options: {
  candidates: string[];
  rationale: string;
  showSuggesting?: boolean;
}): Array<KnownBlock | Block> {
  const blocks: Array<KnownBlock | Block> = [];
  if (options.showSuggesting) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "🤖 Suggesting…" }],
    });
  }

  if (options.candidates.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*🤖 Suggested Next Actions*\n" +
          options.candidates.map((item, idx) => `${idx + 1}. ${item}`).join("\n"),
      },
    });
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Because: ${truncate(options.rationale, 140)}` },
      ],
    });
    blocks.push({
      type: "actions",
      elements: options.candidates.map((_, idx) => ({
        type: "button",
        text: { type: "plain_text", text: `Use #${idx + 1}` },
        action_id: "done_ai_use",
        value: String(idx),
      })),
    } as KnownBlock);
  }

  return blocks;
}

function buildManualNextActionBlocks(): Array<KnownBlock | Block> {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "What’s the next action?" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Write my own" },
          action_id: "done_ai_write",
          value: "write",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip for now" },
          action_id: "done_ai_skip",
          value: "skip",
        },
      ],
    },
  ];
}

async function updateDoneMessage(options: {
  session: ReturnType<typeof getDoneSession>;
  channelId: string;
  client: App["client"];
  text: string;
  blocks: Array<KnownBlock | Block>;
}): Promise<string | undefined> {
  const session = options.session;
  if (!session) {
    return undefined;
  }

  if (session.messageTs) {
    await options.client.chat.update({
      channel: options.channelId,
      ts: session.messageTs,
      text: options.text,
      blocks: options.blocks,
    });
    return session.messageTs;
  }

  const posted = await options.client.chat.postMessage({
    channel: options.channelId,
    text: options.text,
    blocks: options.blocks,
  });
  session.messageTs = posted.ts as string;
  setDoneSession(session);
  return session.messageTs;
}

async function getProjectNextActionSuggestion(options: {
  projectCard: { name: string; desc: string };
  checklistItems: string[];
  recentLogs: string[];
  completedActionTitle: string;
}): Promise<ProjectNextActionSuggestion | null> {
  if (!env.AI_ENABLED) {
    return null;
  }

  const { system, user } = buildProjectNextActionPrompt({
    projectCard: options.projectCard,
    checklistItems: options.checklistItems,
    recentLogs: options.recentLogs,
    completedActionTitle: options.completedActionTitle,
  });

  const result = await generateStructured<ProjectNextActionSuggestion>({
    system,
    user,
    schema: ProjectNextActionSuggestionSchema,
    timeoutMs: 10000,
    maxRetries: 1,
  });

  if (!result.ok) {
    return null;
  }

  if (result.data.confidence < 0.6) {
    return null;
  }

  return result.data;
}

async function showAiNextActionSuggestions(options: {
  session: ReturnType<typeof getDoneSession>;
  channelId: string;
  client: App["client"];
  projectCard: { name: string; desc: string };
  checklistItems: string[];
  recentLogs: string[];
  completedActionTitle: string;
}): Promise<void> {
  const session = options.session;
  if (!session) {
    return;
  }

  await updateDoneMessage({
    session,
    channelId: options.channelId,
    client: options.client,
    text: "Suggesting next action...",
    blocks: buildAiNextActionBlocks({
      candidates: [],
      rationale: "",
      showSuggesting: true,
    }),
  });

  const suggestion = await getProjectNextActionSuggestion({
    projectCard: options.projectCard,
    checklistItems: options.checklistItems,
    recentLogs: options.recentLogs,
    completedActionTitle: options.completedActionTitle,
  });

  const refreshed = getDoneSession(session.userId);
  if (!refreshed) {
    return;
  }

  if (!suggestion) {
    refreshed.aiCandidates = [];
    refreshed.aiRationale = undefined;
    refreshed.forceNewChecklistItem = true;
    setDoneSession(refreshed);
    await updateDoneMessage({
      session: refreshed,
      channelId: options.channelId,
      client: options.client,
      text: "What's the next action?",
      blocks: buildManualNextActionBlocks(),
    });
    return;
  }

  refreshed.aiCandidates = suggestion.candidates;
  refreshed.aiRationale = suggestion.rationale;
  refreshed.forceNewChecklistItem = true;
  setDoneSession(refreshed);

  const suggestionBlocks = buildAiNextActionBlocks({
    candidates: suggestion.candidates,
    rationale: suggestion.rationale,
  });

  const actions: Array<KnownBlock | Block> = [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Write my own" },
          action_id: "done_ai_write",
          value: "write",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip for now" },
          action_id: "done_ai_skip",
          value: "skip",
        },
      ],
    },
  ];

  await updateDoneMessage({
    session: refreshed,
    channelId: options.channelId,
    client: options.client,
    text: "Suggested next actions",
    blocks: [...suggestionBlocks, ...actions],
  });
}

async function finalizeNextActionMessage(options: {
  userId: string;
  client: App["client"];
  channelId: string;
  messageTs?: string;
  text: string;
}): Promise<void> {
  const reviewSession = getReviewSession(options.userId);
  if (reviewSession?.awaitingNextAction && reviewSession.messageTs) {
    reviewSession.awaitingNextAction = false;
    setReviewSession(reviewSession);
    await options.client.chat.update({
      channel: reviewSession.channelId,
      ts: reviewSession.messageTs,
      text: options.text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: options.text },
        },
      ],
    });
    await advanceReview({ session: reviewSession, client: options.client });
    return;
  }

  if (options.messageTs) {
    await options.client.chat.update({
      channel: options.channelId,
      ts: options.messageTs,
      text: options.text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: options.text },
        },
      ],
    });
    return;
  }

  await options.client.chat.postMessage({
    channel: options.channelId,
    text: options.text,
  });
}

async function logNoNextActionDuringReview(options: {
  doneSession: ReturnType<typeof getDoneSession>;
}): Promise<void> {
  const session = options.doneSession;
  if (!session) {
    return;
  }
  const projectCard = await trello.getCard(session.projectCardId);
  const projectBoard = findBoardById(projectCard.idBoard);
  if (!projectBoard) {
    return;
  }
  const updatedDesc = updateProjectFooter(projectCard.desc ?? "", {
    boardKey: projectBoard.key,
    logLine: "No next action set during review",
  });
  await trello.updateCard(projectCard.id, { desc: updatedDesc });
}

function buildClarifiedAppend(options: {
  originalName: string;
  originalDesc: string;
  boardKey: string;
  type: string;
  priorityLabels: string[];
  energyLabels: string[];
  statusLabels: string[];
  deadlineDate?: string;
}): string {
  const originalSnippet = truncate(options.originalDesc || "", 120);
  const lines = [
    "",
    "---",
    "Clarified",
    `Original Title: ${options.originalName}`,
    `Original Description: ${originalSnippet || "None"}`,
    `Board Key: ${options.boardKey}`,
    `Type: ${options.type}`,
    `Priority: ${options.priorityLabels.join(", ") || "None"}`,
    `Energy: ${options.energyLabels.join(", ") || "None"}`,
    `Flags: ${options.statusLabels.join(", ") || "None"}`,
  ];
  if (options.deadlineDate) {
    lines.push(`Deadline: ${options.deadlineDate}`);
  }
  return lines.join("\n");
}

function truncateForTitle(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
}

async function applyClarifyToTrello(options: {
  session: ReturnType<typeof getSession>;
  client: App["client"];
}) {
  const session = options.session;
  if (!session) {
    throw new Error("No session available");
  }

  const boardSelection = session.answers.board;
  if (!boardSelection) {
    throw new Error("Missing board selection");
  }

  const actionable = session.answers.actionable;
  const projectType = session.answers.project;
  const nonActionable = session.answers.nonActionable;

  let destinationListId = "";
  let destinationBoardId: string | undefined;
  let destinationListName = "";
  let typeLabel = "";
  let boardKeyLabel = "";

  if (boardSelection === "inbox_reference") {
    boardKeyLabel = "inbox";
    if (actionable === "yes") {
      destinationListId = env.TRELLO_INBOX_QUICK_LIST_ID;
      destinationListName = "quick";
      typeLabel = "Single Action";
    } else {
      destinationListId = env.TRELLO_INBOX_REFERENCE_LIST_ID;
      destinationListName = "reference";
      typeLabel = nonActionable === "maybe" ? "Someday" : "Reference";
    }
  } else {
    const mappedKey = mapBoardSelectionToKey(boardSelection);
    if (!mappedKey) {
      throw new Error(`Unknown board selection: ${boardSelection}`);
    }

    const boardConfig = getBoardByKey(boardsConfig, mappedKey);
    if (!boardConfig) {
      throw new Error(`Board config not found for key: ${mappedKey}`);
    }

    if (
      boardConfig.boardId === "REPLACE_ME" ||
      Object.values(boardConfig.lists).some((value) => value === "REPLACE_ME")
    ) {
      throw new Error(`Board config not set for key: ${mappedKey}`);
    }

    destinationBoardId = boardConfig.boardId;
    boardKeyLabel = boardConfig.key;

    if (actionable === "yes") {
      if (projectType === "project") {
        destinationListId = boardConfig.lists.projects;
        destinationListName = "projects";
        typeLabel = "Project";
      } else {
        destinationListId = boardConfig.lists.actionItems;
        destinationListName = "actionItems";
        typeLabel = "Single Action";
      }
    } else {
      if (nonActionable === "maybe") {
        destinationListId = boardConfig.lists.maybeSomeday;
        destinationListName = "maybeSomeday";
        typeLabel = "Someday";
      } else {
        destinationListId = boardConfig.lists.reference;
        destinationListName = "reference";
        typeLabel = "Reference";
      }
    }
  }

  if (!destinationListId) {
    throw new Error("Missing destination list");
  }

  const currentCard = session.cards[session.index];
  const clarifiedAppend = buildClarifiedAppend({
    originalName: currentCard.name,
    originalDesc: currentCard.desc,
    boardKey: boardKeyLabel,
    type: typeLabel,
    priorityLabels: session.priorityLabels ?? [],
    energyLabels: session.energyLabels ?? [],
    statusLabels: session.statusLabels ?? [],
    deadlineDate: session.deadlineDate,
  });

  const updatedDesc = currentCard.desc
    ? `${currentCard.desc}\n${clarifiedAppend.trimStart()}`
    : clarifiedAppend.trimStart();

  const updatePatch: { name?: string; desc?: string; due?: string | null } = {
    desc: updatedDesc,
  };

  if (actionable === "yes") {
    if (!session.nextActionText || session.nextActionText.trim().length === 0) {
      throw new Error("Missing next action text");
    }
    updatePatch.name = truncateForTitle(session.nextActionText, 120);
  }

  if (session.deadlineDate) {
    updatePatch.due = session.deadlineDate;
  }

  if (actionable === "yes" && projectType === "project" && destinationBoardId) {
    if (!session.projectName || session.projectName.trim().length === 0) {
      throw new Error("Missing project name");
    }

    const existingFooter = parseFooter(currentCard.desc ?? "");
    const projectFooter = buildFooter({
      type: "project",
      board: mapBoardKeyToFooterBoard(boardKeyLabel),
      list: "projects",
      links: existingFooter?.links ?? {},
      slack: existingFooter?.slack,
      log: [...(existingFooter?.log ?? []), "Filed as project via clarify"],
    });

    const descBody = session.projectDescription?.trim()
      ? `${session.projectDescription.trim()}\n\n`
      : "";
    const projectDesc = appendOrReplaceFooter(
      descBody + (currentCard.desc ?? ""),
      projectFooter
    );

    await trello.updateCard(currentCard.id, {
      name: truncateForTitle(session.projectName, 120),
      desc: projectDesc,
    });
    await trello.moveCardToList(
      currentCard.id,
      destinationListId,
      destinationBoardId
    );

    const existingChecklists = await trello.getChecklistsOnCard(
      currentCard.id
    );
    const planChecklist = existingChecklists.find(
      (checklist) => checklist.name === "Project Plan"
    );
    const checklistId = planChecklist
      ? planChecklist.id
      : (await trello.createChecklist(currentCard.id, "Project Plan")).id;

    await trello.addChecklistItem(
      checklistId,
      `[NEXT] ${truncateForTitle(session.nextActionText ?? "", 120)}`
    );

    const actionDesc = appendOrReplaceFooter(
      session.nextActionNotes?.trim()
        ? `${session.nextActionNotes.trim()}\n\n`
        : "",
      buildFooter({
        type: "action",
        board: mapBoardKeyToFooterBoard(boardKeyLabel),
        list: "actionItems",
        links: { projectCardUrl: currentCard.url },
        log: ["Created as next action via clarify"],
      })
    );

    const boardConfig = getBoardByKey(
      boardsConfig,
      boardKeyLabel as "growth" | "embxr" | "bdxr"
    );
    if (!boardConfig) {
      throw new Error(`Board config not found for key: ${boardKeyLabel}`);
    }

    const actionCard = await trello.createCardInList(
      boardConfig.lists.actionItems,
      truncateForTitle(session.nextActionText ?? "", 120),
      actionDesc
    );

    const labelsToApply = [
      ...(session.priorityLabels ?? []),
      ...(session.energyLabels ?? []),
      ...(session.statusLabels ?? []),
    ];

    if (labelsToApply.length > 0) {
      for (const label of labelsToApply) {
        const applied = await trello.addLabelByName(
          actionCard.id,
          destinationBoardId,
          label
        );
        if (!applied) {
          console.warn(`Label not found on board: ${label}`);
        }
      }
    }

    if (session.deadlineDate) {
      await trello.updateCard(actionCard.id, {
        due: session.deadlineDate,
      });
    }

    const existingProjectFooter = parseFooter(projectDesc);
    const baseFooter = buildFooter({
      type: "project",
      board: mapBoardKeyToFooterBoard(boardKeyLabel),
      list: "projects",
      links: {
        ...(existingProjectFooter?.links ?? {}),
        actionCardUrl: actionCard.url,
      },
      slack: existingProjectFooter?.slack,
      log: existingProjectFooter?.log ?? [],
    });

    const updatedProjectFooter = appendLogLine(
      appendOrReplaceFooter(projectDesc, baseFooter),
      `Next action created: ${actionCard.url}`
    );

    await trello.updateCard(currentCard.id, {
      desc: updatedProjectFooter,
    });

    return {
      boardKeyLabel,
      destinationListName,
      labels: labelsToApply,
    };
  }

  await trello.updateCard(currentCard.id, updatePatch);
  await trello.moveCardToList(
    currentCard.id,
    destinationListId,
    destinationBoardId
  );

  const labelsToApply = [
    ...(session.priorityLabels ?? []),
    ...(session.energyLabels ?? []),
    ...(session.statusLabels ?? []),
  ];

  if (destinationBoardId && labelsToApply.length > 0) {
    for (const label of labelsToApply) {
      const applied = await trello.addLabelByName(
        currentCard.id,
        destinationBoardId,
        label
      );
      if (!applied) {
        console.warn(`Label not found on board: ${label}`);
      }
    }
  } else if (!destinationBoardId && labelsToApply.length > 0) {
    console.warn("No destination board id available for label application");
  }

  return {
    boardKeyLabel,
    destinationListName,
    labels: labelsToApply,
  };
}

async function handleClarifyCommitAction(
  body: { user: { id: string }; channel?: { id?: string } },
  client: App["client"]
) {
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  try {
    const result = await applyClarifyToTrello({ session, client });

    session.lastFiled = {
      board: result.boardKeyLabel,
      list: result.destinationListName,
      labels: result.labels,
    };

    const nextIndex = session.index + 1;
    if (nextIndex >= session.cards.length) {
      clearSession(userId);
      if (session.sessionMessageTs) {
        await client.chat.update({
          channel: session.channelId,
          ts: session.sessionMessageTs,
          text: "Clarify session complete ✅",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "Clarify session complete ✅" },
            },
          ],
        });
      }
      return;
    }

    session.index = nextIndex;
    session.state = "review";
    session.answers = {};
    session.nextActionText = undefined;
    session.nextActionNotes = undefined;
    session.priorityLabels = [];
    session.energyLabels = [];
    session.statusLabels = [];
    session.deadlineDate = undefined;
    session.suggestion = undefined;
    session.suggestionChoice = undefined;
    session.suggestionCardId = undefined;
    session.projectName = undefined;
    session.projectDescription = undefined;
    setSession(session);

    if (!session.sessionMessageTs) {
      const messageTs = await postClarifyCard({
        channelId: session.channelId,
        index: nextIndex + 1,
        total: session.cards.length,
        card: session.cards[nextIndex],
        client,
        lastFiled: session.lastFiled,
      });
      session.sessionMessageTs = messageTs;
      setSession(session);
      return;
    }

    await updateClarifyCard({
      channelId: session.channelId,
      messageTs: session.sessionMessageTs,
      index: nextIndex + 1,
      total: session.cards.length,
      card: session.cards[nextIndex],
      lastFiled: session.lastFiled,
      client,
    });
  } catch (error) {
    console.error(error);
    if (session.sessionMessageTs) {
      await client.chat.update({
        channel: session.channelId,
        ts: session.sessionMessageTs,
        text: "⚠️ Filing failed. Try again.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "⚠️ Filing failed. Try again." },
          },
        ],
      });
    }
  }
}

app.action("clarify_commit", async ({ ack, body, client }) => {
  await ack();
  await handleClarifyCommitAction(body, client);
});

app.action("clarify_confirm_commit", async ({ ack, body, client }) => {
  await ack();
  await handleClarifyCommitAction(body, client);
});

app.action("clarify_confirm_back", async ({ ack, body, client }) => {
  await ack();
  await handleStepNavigation(body, client, "boardSelect");
});

app.action("clarify_confirm_cancel", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const session = getSession(userId);
  if (!session || session.channelId !== body.channel?.id) {
    await updateSessionExpiredFromAction(body, client);
    return;
  }

  session.state = "review";
  session.answers = {};
  session.priorityLabels = [];
  session.energyLabels = [];
  session.statusLabels = [];
  session.deadlineDate = undefined;
  session.nextActionText = undefined;
  session.nextActionNotes = undefined;
  session.projectName = undefined;
  session.projectDescription = undefined;
  setSession(session);

  if (session.sessionMessageTs) {
    await updateClarifyCard({
      channelId: session.channelId,
      messageTs: session.sessionMessageTs,
      index: session.index + 1,
      total: session.cards.length,
      card: session.cards[session.index],
      lastFiled: session.lastFiled,
      client,
    });
  }
});

async function openDoneNextActionModal(
  triggerId: string,
  client: App["client"]
) {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "done_next_action_modal",
      title: { type: "plain_text", text: "Next Action" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "next_action_block",
          label: { type: "plain_text", text: "Next Action" },
          element: {
            type: "plain_text_input",
            action_id: "next_action_input",
          },
        },
        {
          type: "input",
          block_id: "notes_block",
          optional: true,
          label: { type: "plain_text", text: "Notes" },
          element: {
            type: "plain_text_input",
            action_id: "notes_input",
            multiline: true,
          },
        },
      ],
    } as ModalView,
  });
}

async function handleDoneFromUrl(options: {
  userId: string;
  channelId: string;
  cardUrl: string;
  client: App["client"];
  respond?: (text: string) => Promise<void>;
  silent?: boolean;
}) {
  const cardId = parseTrelloCardIdFromUrl(options.cardUrl);
  if (!cardId) {
    if (options.respond) {
      await options.respond("Invalid Trello card URL.");
    }
    return;
  }

  try {
    const actionCard = await trello.getCard(cardId);
    const boardConfig = findBoardById(actionCard.idBoard);
    if (!boardConfig) {
      if (options.respond) {
        await options.respond("Board not found for this card.");
      }
      return;
    }

    await trello.moveCardToList(
      actionCard.id,
      boardConfig.lists.doneWeekly,
      boardConfig.boardId
    );

    const completedAt = new Date().toISOString();
    const updatedActionDesc = appendLogLine(
      actionCard.desc ?? "",
      `Completed: ${completedAt}`
    );
    await trello.updateCard(actionCard.id, { desc: updatedActionDesc });

    const actionFooter = parseFooter(actionCard.desc ?? "");
    const projectUrl = actionFooter?.links?.projectCardUrl;

    if (!projectUrl) {
      if (options.respond && !options.silent) {
        await options.respond("✅ Done. No linked project found.");
      }
      return;
    }

    const projectId = parseTrelloCardIdFromUrl(projectUrl);
    if (!projectId) {
      if (options.respond && !options.silent) {
        await options.respond("✅ Done. Project link invalid.");
      }
      return;
    }

    const projectCard = await trello.getCard(projectId);
    const projectBoard = findBoardById(projectCard.idBoard);
    if (!projectBoard) {
      if (options.respond && !options.silent) {
        await options.respond("✅ Done. Project board not found.");
      }
      return;
    }

    const checklists = await trello.getChecklistsOnCard(projectCard.id);
    const planChecklist = checklists.find(
      (checklist) => checklist.name === "Project Plan"
    );
    const checklistId = planChecklist
      ? planChecklist.id
      : (await trello.createChecklist(projectCard.id, "Project Plan")).id;

    const items = await trello.getChecklistItems(checklistId);
    const { currentMatch, nextItem } = findNextChecklistItem(
      items,
      actionCard.name
    );

    if (currentMatch) {
      await trello.updateChecklistItemState(
        projectCard.id,
        currentMatch.id,
        "complete"
      );
    }

    const updatedProjectDesc = updateProjectFooter(projectCard.desc ?? "", {
      boardKey: projectBoard.key,
      logLine: `Completed next action: ${actionCard.name} (${completedAt})`,
    });
    await trello.updateCard(projectCard.id, { desc: updatedProjectDesc });

    const hasActiveNext = items.some(
      (item) => item.state === "incomplete" && item.name.startsWith("[NEXT]")
    );

    if (nextItem) {
      setDoneSession({
        userId: options.userId,
        channelId: options.channelId,
        actionCardId: actionCard.id,
        actionCardName: actionCard.name,
        projectCardId: projectCard.id,
        projectCardUrl: projectCard.url,
        projectBoardId: projectBoard.boardId,
        checklistId,
        nextItemId: nextItem.id,
        nextItemName: nextItem.name,
        needsSuggestion: !hasActiveNext,
      });

      if (!options.silent) {
        const session = getDoneSession(options.userId);
        if (session) {
          if (!hasActiveNext) {
            const humanDesc = stripFooter(projectCard.desc ?? "");
            const recentLogs = (parseFooter(projectCard.desc ?? "")?.log ?? []).slice(
              -5
            );
            const checklistItems = items
              .filter((item) => item.state === "incomplete")
              .map((item) => item.name);
            await showAiNextActionSuggestions({
              session,
              channelId: options.channelId,
              client: options.client,
              projectCard: { name: projectCard.name, desc: humanDesc },
              checklistItems,
              recentLogs,
              completedActionTitle: actionCard.name,
            });
          } else {
            await updateDoneMessage({
              session,
              channelId: options.channelId,
              client: options.client,
              text: "Set this as the next action?",
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `Set this as the next action?\n*${nextItem.name}*`,
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Yes" },
                      action_id: "done_next_yes",
                      value: "yes",
                    },
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Suggest next action" },
                      action_id: "done_next_suggest",
                      value: "suggest",
                    },
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Pick different" },
                      action_id: "done_next_pick",
                      value: "pick",
                    },
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Not now" },
                      action_id: "done_next_notnow",
                      value: "notnow",
                    },
                  ],
                },
              ],
            });
          }
        }
      }
      return;
    }

    setDoneSession({
      userId: options.userId,
      channelId: options.channelId,
      actionCardId: actionCard.id,
      actionCardName: actionCard.name,
      projectCardId: projectCard.id,
      projectCardUrl: projectCard.url,
      projectBoardId: projectBoard.boardId,
      checklistId,
      needsSuggestion: true,
    });

    if (!options.silent) {
      const session = getDoneSession(options.userId);
      if (session) {
        const humanDesc = stripFooter(projectCard.desc ?? "");
        const recentLogs = (parseFooter(projectCard.desc ?? "")?.log ?? []).slice(
          -5
        );
        const checklistItems = items
          .filter((item) => item.state === "incomplete")
          .map((item) => item.name);
        await showAiNextActionSuggestions({
          session,
          channelId: options.channelId,
          client: options.client,
          projectCard: { name: projectCard.name, desc: humanDesc },
          checklistItems,
          recentLogs,
          completedActionTitle: actionCard.name,
        });
        return;
      }
    }

    if (options.respond && !options.silent) {
      await options.respond("✅ Done.");
    }
  } catch (error) {
    console.error(error);
    if (options.respond && !options.silent) {
      await options.respond("⚠️ Done flow failed. Try again.");
    }
  }
}

app.command("/done", async ({ ack, respond, command, client }) => {
  await ack();

  const url = command.text.trim();
  if (!url) {
    await respond("Please provide a Trello card URL.");
    return;
  }

  await handleDoneFromUrl({
    userId: command.user_id,
    channelId: command.channel_id,
    cardUrl: url,
    client,
    respond,
  });
});

function formatDateYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isDueTodayOrOverdue(due: string | null | undefined): boolean {
  if (!due) {
    return false;
  }
  const dueDate = new Date(due);
  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }
  const today = formatDateYYYYMMDD(new Date());
  const dueDay = formatDateYYYYMMDD(dueDate);
  return dueDay <= today;
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLabel(card: { labels?: Array<{ name: string }> }, label: string) {
  const target = normalizeLabel(label);
  return (card.labels ?? []).some((l) => normalizeLabel(l.name) === target);
}

function sortCardsForBrief<T extends { name: string; due?: string | null }>(
  cards: T[]
): T[] {
  return [...cards].sort((a, b) => {
    const aDue = a.due ? new Date(a.due).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.due ? new Date(b.due).getTime() : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) {
      return aDue - bDue;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatCardLine(card: {
  name: string;
  url?: string;
  due?: string | null;
  labels?: Array<{ name: string }>;
}): string {
  const parts: string[] = [];
  if (card.due) {
    const dueDay = formatDateYYYYMMDD(new Date(card.due));
    parts.push(`due ${dueDay}`);
  }
  if (hasLabel(card, "⛔ Blocked")) {
    parts.push("blocked");
  }
  const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const title = `${card.name}${meta}`;
  if (!card.url) {
    return `• ${title}`;
  }
  return `• ${title} — ${card.url}`;
}

async function runBrief(options: {
  userId: string;
  channelId: string;
  triggerId?: string;
  client: App["client"];
}) {
  const today = formatDateYYYYMMDD(new Date());
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: { type: "plain_text", text: `Morning Brief — ${today}` },
    },
  ];

  let quickWin: { name: string; url: string } | null = null;
  let deepWork: { name: string; url: string } | null = null;
  const stalledProjects: Array<{ name: string }> = [];
  const briefCards: Array<{ id: string; url: string; name: string; board: string }> = [];

  for (const board of boardsConfig.boards) {
    const actionCards = await trello.getCardsInList(board.lists.actionItems, {
      limit: 30,
    });
    const inProgressCards = await trello.getCardsInList(board.lists.inProgress, {
      limit: 30,
    });

    const due = actionCards.filter((card) => isDueTodayOrOverdue(card.due));
    const p1 = actionCards.filter((card) => hasLabel(card, "P1 - Focus"));
    const p2 = actionCards.filter((card) => hasLabel(card, "P2 - Important"));

    const dueTop = sortCardsForBrief(due).slice(0, 3);
    const p1Top = sortCardsForBrief(p1).slice(0, 3);
    const p2Top = sortCardsForBrief(p2).slice(0, 3);
    const inProgressTop = sortCardsForBrief(inProgressCards).slice(0, 3);

    if (!quickWin) {
      const quick = actionCards.find((card) => hasLabel(card, "⚡<30 min"));
      if (quick) {
        quickWin = { name: quick.name, url: quick.url };
      }
    }
    if (!deepWork) {
      const deep = actionCards.find((card) => hasLabel(card, "🧠 Deep"));
      if (deep) {
        deepWork = { name: deep.name, url: deep.url };
      }
    }

    const sectionLines = [
      `*${board.name}*`,
      "",
      "*Due / Overdue*",
      dueTop.length > 0 ? dueTop.map(formatCardLine).join("\n") : "• None",
      "",
      "*Focus (P1)*",
      p1Top.length > 0 ? p1Top.map(formatCardLine).join("\n") : "• None",
      "",
      "*Important (P2)*",
      p2Top.length > 0 ? p2Top.map(formatCardLine).join("\n") : "• None",
      "",
      "*In Progress*",
      inProgressTop.length > 0
        ? inProgressTop.map(formatCardLine).join("\n")
        : "• None",
    ];

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: sectionLines.join("\n"),
      },
    });

    blocks.push({ type: "divider" });

    if (stalledProjects.length < 3) {
      const projectCards = await trello.getCardsInList(board.lists.projects, {
        limit: 30,
      });
      for (const project of projectCards) {
        if (stalledProjects.length >= 3) {
          break;
        }
        const footer = parseFooter(project.desc ?? "");
        const actionUrl = footer?.links?.actionCardUrl;
        if (!actionUrl) {
          stalledProjects.push({ name: project.name });
          continue;
        }
        const actionId = parseTrelloCardIdFromUrl(actionUrl);
        if (!actionId) {
          stalledProjects.push({ name: project.name });
          continue;
        }
        const actionCard = await trello.getCard(actionId);
        if (actionCard.idList === board.lists.doneWeekly) {
          stalledProjects.push({ name: project.name });
        }
      }
    }

    actionCards.forEach((card) => {
      briefCards.push({ id: card.id, url: card.url, name: card.name, board: board.name });
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*Quick win pick*",
        quickWin ? formatCardLine(quickWin) : "• None",
        "",
        "*Deep work pick*",
        deepWork ? formatCardLine(deepWork) : "• None",
      ].join("\n"),
    },
  });

  if (stalledProjects.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*⚠️ Projects Without Active Next Action*\n" +
          stalledProjects.map((project) => `• ${project.name}`).join("\n"),
      },
    });
  }

  await options.client.chat.postMessage({
    channel: options.channelId,
    text: `Morning Brief — ${today}`,
    blocks,
  });

  setBriefForUser(options.userId, { date: today, cards: briefCards });

  if (options.triggerId) {
    const maxSelect = Math.min(5, briefCards.length);
    const grouped = new Map<string, typeof briefCards>();
    briefCards.forEach((card) => {
      const list = grouped.get(card.board) ?? [];
      list.push(card);
      grouped.set(card.board, list);
    });

    const option_groups = Array.from(grouped.entries()).map(
      ([boardName, cards]) => ({
        label: { type: "plain_text" as const, text: boardName },
        options: cards.slice(0, 25).map((card) => ({
          text: {
            type: "plain_text" as const,
            text: truncateForTitle(card.name, 75),
          },
          value: card.id,
        })),
      })
    );

    await options.client.views.open({
      trigger_id: options.triggerId,
      view: {
        type: "modal",
        callback_id: "brief_select_modal",
        title: { type: "plain_text", text: "Pick Today's 5" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: String(maxSelect),
        blocks: [
          {
            type: "input",
            block_id: "brief_select_block",
            label: { type: "plain_text", text: "Select tasks for today" },
            element: {
              type: "multi_static_select",
              action_id: "brief_select_input",
              option_groups,
              max_selected_items: maxSelect,
            },
          },
        ],
      },
    });
  }
}

app.command("/brief", async ({ ack, command, client }) => {
  await ack();
  await runBrief({
    userId: command.user_id,
    channelId: command.user_id,
    triggerId: command.trigger_id,
    client,
  });
});

app.view("brief_select_modal", async ({ ack, body, view, client }) => {
  const selected =
    view.state.values["brief_select_block"]?.["brief_select_input"]
      ?.selected_options ?? [];
  const selectedIds = selected.map((opt) => opt.value);
  const required = Number(view.private_metadata || "5");
  if (selectedIds.length !== required) {
    await ack({
      response_action: "errors",
      errors: {
        brief_select_block: `Please select exactly ${required} items.`,
      },
    });
    return;
  }

  await ack({ response_action: "clear" });

  setBriefSelectionForUser(body.user.id, selectedIds);
});

async function createNextActionForProject(options: {
  userId: string;
  nextActionText: string;
  notes?: string;
  logLine?: string;
  useExistingChecklistItem?: boolean;
}): Promise<void> {
  const session = getDoneSession(options.userId);
  if (!session) {
    return;
  }

  const projectBoard = findBoardById(session.projectBoardId);
  if (!projectBoard) {
    throw new Error("Project board not found");
  }

  const actionDesc = appendOrReplaceFooter(
    options.notes?.trim() ? `${options.notes.trim()}\n\n` : "",
    buildFooter({
      type: "action",
      board: mapBoardKeyToFooterBoard(projectBoard.key),
      list: "actionItems",
      links: { projectCardUrl: session.projectCardUrl },
      log: [options.logLine ?? "Created as next action via /done"],
    })
  );

  const actionCard = await trello.createCardInList(
    projectBoard.lists.actionItems,
    truncateForTitle(options.nextActionText, 120),
    actionDesc
  );

  const shouldUpdateExisting =
    options.useExistingChecklistItem !== false && !!session.nextItemId;
  if (shouldUpdateExisting) {
    const updatedName = ensureNextPrefix(
      truncateForTitle(options.nextActionText, 120)
    );
    await trello.updateChecklistItemName(
      session.projectCardId,
      session.nextItemId as string,
      updatedName
    );
  } else {
    await trello.addChecklistItem(
      session.checklistId,
      ensureNextPrefix(truncateForTitle(options.nextActionText, 120))
    );
  }

  const projectCard = await trello.getCard(session.projectCardId);
  const updatedDesc = updateProjectFooter(projectCard.desc ?? "", {
    boardKey: projectBoard.key,
    links: { actionCardUrl: actionCard.url },
    logLine: options.logLine
      ? `${options.logLine}: ${actionCard.url}`
      : `Next action created: ${actionCard.url}`,
  });
  await trello.updateCard(projectCard.id, { desc: updatedDesc });
}

app.action("done_next_yes", async ({ ack, body, client }) => {
  await ack();

  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  const nextText = session.nextItemName ?? "";
  if (!nextText) {
    return;
  }

  await createNextActionForProject({
    userId: session.userId,
    nextActionText: nextText.replace(/^\[NEXT\]\s*/, ""),
    useExistingChecklistItem: session.forceNewChecklistItem !== true,
  });

  clearDoneSession(session.userId);
  if (session.messageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "✅ Next action created.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "✅ Next action created." },
        },
      ],
    });
  } else {
    await client.chat.postMessage({
      channel: session.channelId,
      text: "✅ Next action created.",
    });
  }
});

app.action("done_next_pick", async ({ ack, body, client }) => {
  await ack();

  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await openDoneNextActionModal(body.trigger_id, client);
  }
});

app.action("done_next_suggest", async ({ ack, body, client }) => {
  await ack();
  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  session.forceNewChecklistItem = true;
  setDoneSession(session);

  const projectCard = await trello.getCard(session.projectCardId);
  const checklistItems = (
    await trello.getChecklistItems(session.checklistId)
  )
    .filter((item) => item.state === "incomplete")
    .map((item) => item.name);
  const recentLogs = (parseFooter(projectCard.desc ?? "")?.log ?? []).slice(-5);
  await showAiNextActionSuggestions({
    session,
    channelId: session.channelId,
    client,
    projectCard: {
      name: projectCard.name,
      desc: stripFooter(projectCard.desc ?? ""),
    },
    checklistItems,
    recentLogs,
    completedActionTitle: session.actionCardName,
  });
});

app.action("done_next_notnow", async ({ ack, body, client }) => {
  await ack();
  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  clearDoneSession(session.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "Okay, not now.",
  });
});

app.view("done_next_action_modal", async ({ ack, body, view, client }) => {
  const nextAction =
    view.state.values["next_action_block"]?.["next_action_input"]?.value ?? "";
  if (nextAction.trim().length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        next_action_block: "Next action is required.",
      },
    });
    return;
  }

  await ack({ response_action: "clear" });

  const notes =
    view.state.values["notes_block"]?.["notes_input"]?.value ?? "";

  const session = getDoneSession(body.user.id);
  if (!session) {
    return;
  }

  await createNextActionForProject({
    userId: session.userId,
    nextActionText: nextAction,
    notes,
    useExistingChecklistItem: session.forceNewChecklistItem !== true,
  });

  clearDoneSession(session.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "✅ Next action created.",
  });
});

app.action("done_ai_use", async ({ ack, body, client }) => {
  await ack();
  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  let value = "";
  if (
    "actions" in body &&
    Array.isArray(body.actions) &&
    body.actions[0] &&
    "value" in body.actions[0]
  ) {
    value = String((body.actions[0] as { value?: string }).value ?? "");
  }

  const index = Number(value);
  const candidate = session.aiCandidates?.[index];
  if (!candidate) {
    return;
  }

  await createNextActionForProject({
    userId: session.userId,
    nextActionText: candidate,
    logLine: "AI suggested next action selected",
    useExistingChecklistItem: false,
  });

  clearDoneSession(session.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "✅ Next action created.",
  });
});

app.action("done_ai_write", async ({ ack, body, client }) => {
  await ack();
  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.forceNewChecklistItem = true;
  setDoneSession(session);
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await openDoneNextActionModal(body.trigger_id, client);
  }
});

app.action("done_ai_skip", async ({ ack, body, client }) => {
  await ack();
  const session = getDoneSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  const reviewSession = getReviewSession(session.userId);
  if (reviewSession?.awaitingNextAction) {
    reviewSession.suppressNextActionPrompt = true;
    setReviewSession(reviewSession);
    await logNoNextActionDuringReview({ doneSession: session });
  }
  clearDoneSession(session.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "Okay, skipping for now.",
  });
});

async function postReviewCard(options: {
  channelId: string;
  card: { name: string; url: string };
  index: number;
  total: number;
  client: App["client"];
}): Promise<string> {
  const response = await options.client.chat.postMessage({
    channel: options.channelId,
    text: "End-of-Day Review",
    blocks: renderReviewSession({
      index: options.index,
      total: options.total,
      card: options.card,
    }),
  });
  return response.ts as string;
}

async function updateReviewCard(options: {
  channelId: string;
  messageTs: string;
  card: { name: string; url: string };
  index: number;
  total: number;
  client: App["client"];
}) {
  await updateSessionMessage(
    options.client,
    options.channelId,
    options.messageTs,
    renderReviewSession({
      index: options.index,
      total: options.total,
      card: options.card,
    }),
    "End-of-Day Review"
  );
}

async function advanceReview(options: {
  session: ReturnType<typeof getReviewSession>;
  client: App["client"];
}) {
  const session = options.session;
  if (!session) {
    return;
  }

  const nextIndex = session.index + 1;
  if (nextIndex >= session.cards.length) {
    const summary = `Review complete ✅\nTotal hours: ${session.totalHours}\nDone: ${session.doneCount}\nProgress: ${session.progressCount}\nBlocked: ${session.blockedCount}\nNo progress: ${session.noProgressCount}\nSkipped: ${session.skipCount}`;
    clearReviewSession(session.userId);
    if (session.messageTs) {
      await options.client.chat.update({
        channel: session.channelId,
        ts: session.messageTs,
        text: summary,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: summary },
          },
        ],
      });
    }
    return;
  }

  session.index = nextIndex;
  setReviewSession(session);

  const card = await trello.getCard(session.cards[nextIndex].id);
  if (!session.messageTs) {
    const messageTs = await postReviewCard({
      channelId: session.channelId,
      card: { name: card.name, url: card.url },
      index: nextIndex + 1,
      total: session.cards.length,
      client: options.client,
    });
    session.messageTs = messageTs;
    setReviewSession(session);
    return;
  }

  await updateReviewCard({
    channelId: session.channelId,
    messageTs: session.messageTs,
    card: { name: card.name, url: card.url },
    index: nextIndex + 1,
    total: session.cards.length,
    client: options.client,
  });
}

async function logProgressToCards(options: {
  actionCardId: string;
  status: "progress" | "blocked";
  hours: number;
  notes?: string;
}) {
  const date = formatDateYYYYMMDD(new Date());
  const noteText = options.notes?.trim()
    ? ` — ${options.notes.trim()}`
    : "";
  const actionCard = await trello.getCard(options.actionCardId);
  const actionLine = `${date}: +${options.hours}h${noteText} (status: ${options.status})`;
  const updatedActionDesc = appendLogLine(actionCard.desc ?? "", actionLine);
  await trello.updateCard(actionCard.id, { desc: updatedActionDesc });

  const actionFooter = parseFooter(actionCard.desc ?? "");
  const projectUrl = actionFooter?.links?.projectCardUrl;
  if (!projectUrl) {
    return;
  }

  const projectId = parseTrelloCardIdFromUrl(projectUrl);
  if (!projectId) {
    return;
  }

  const projectCard = await trello.getCard(projectId);
  const projectBoard = findBoardById(projectCard.idBoard);
  if (!projectBoard) {
    return;
  }

  const projectLine = `${date}: +${options.hours}h on ${actionCard.name}`;
  const updatedProjectDesc = updateProjectFooterWithHours({
    desc: projectCard.desc ?? "",
    boardKey: projectBoard.key,
    logLine: projectLine,
    hours: options.hours,
  });
  await trello.updateCard(projectCard.id, { desc: updatedProjectDesc });
}

app.command("/review", async ({ ack, command, respond, client }) => {
  await ack();

  if (
    !command.channel_id.startsWith("D") &&
    command.channel_name !== "directmessage"
  ) {
    await respond("Please run /review in a DM with me.");
    return;
  }

  await startReview({
    userId: command.user_id,
    channelId: command.channel_id,
    client,
    respond,
  });
});

async function startReview(options: {
  userId: string;
  channelId: string;
  client: App["client"];
  respond?: (text: string) => Promise<void>;
}) {
  const today = formatDateYYYYMMDD(new Date());
  const history = readBriefHistory();
  const entry = history[options.userId];
  if (!entry || entry.date !== today) {
    if (options.respond) {
      await options.respond("No brief found for today—run /brief first.");
    }
    return;
  }
  if (!entry.selected || entry.selected.length === 0) {
    if (options.respond) {
      await options.respond("No tasks selected for today—run /brief and pick 5.");
    }
    return;
  }

  const reviewSession: ReviewSession = {
    userId: options.userId,
    channelId: options.channelId,
    cards: entry.selected.map(({ id, url }) => ({ id, url })),
    index: 0,
    totalHours: 0,
    doneCount: 0,
    progressCount: 0,
    blockedCount: 0,
    noProgressCount: 0,
    skipCount: 0,
    messageTs: undefined,
  };
  setReviewSession(reviewSession);

  const card = await trello.getCard(entry.selected[0].id);
  const messageTs = await postReviewCard({
    channelId: options.channelId,
    card: { name: card.name, url: card.url },
    index: 1,
    total: entry.selected.length,
    client: options.client,
  });
  reviewSession.messageTs = messageTs;
  setReviewSession(reviewSession);
}

app.action("review_done", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  const card = session.cards[session.index];
  session.doneCount += 1;
  setReviewSession(session);

  await handleDoneFromUrl({
    userId: session.userId,
    channelId: session.channelId,
    cardUrl: card.url,
    client,
    silent: true,
  });

  const doneSession = getDoneSession(session.userId);
  if (doneSession && session.messageTs) {
    session.awaitingNextAction = true;
    setReviewSession(session);
    doneSession.messageTs = session.messageTs;
    setDoneSession(doneSession);

    if (session.suppressNextActionPrompt) {
      clearDoneSession(doneSession.userId);
      await client.chat.update({
        channel: session.channelId,
        ts: session.messageTs,
        text: "Done ✅",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `Done ✅ *${card.url}*` },
          },
        ],
      });
      await advanceReview({ session, client });
      return;
    }

    if (doneSession.needsSuggestion) {
      const projectCard = await trello.getCard(doneSession.projectCardId);
      const checklistItems = (
        await trello.getChecklistItems(doneSession.checklistId)
      )
        .filter((item) => item.state === "incomplete")
        .map((item) => item.name);
      const recentLogs = (parseFooter(projectCard.desc ?? "")?.log ?? []).slice(-5);
      await showAiNextActionSuggestions({
        session: doneSession,
        channelId: session.channelId,
        client,
        projectCard: {
          name: projectCard.name,
          desc: stripFooter(projectCard.desc ?? ""),
        },
        checklistItems,
        recentLogs,
        completedActionTitle: doneSession.actionCardName,
      });
      return;
    }

    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "Set next action?",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Set this as the next action?\n*${doneSession.nextItemName ?? "Enter a new next action"}*`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Yes" },
              action_id: "review_done_next_yes",
              value: "yes",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Suggest next action" },
              action_id: "review_done_next_suggest",
              value: "suggest",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Pick different" },
              action_id: "review_done_next_pick",
              value: "pick",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Not now" },
              action_id: "review_done_next_notnow",
              value: "notnow",
            },
          ],
        },
      ],
    });
    return;
  }

  if (session.messageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "Done ✅",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `Done ✅ *${card.url}*` },
        },
      ],
    });
  }

  await advanceReview({ session, client });
});

app.action("review_progress", async ({ ack, body }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.pendingStatus = "progress";
  setReviewSession(session);
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await openReviewProgressModal(body.trigger_id);
  }
});

app.action("review_blocked", async ({ ack, body }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.pendingStatus = "blocked";
  setReviewSession(session);
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await openReviewProgressModal(body.trigger_id);
  }
});

app.action("review_noprogress", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }

  const date = formatDateYYYYMMDD(new Date());
  const actionCard = await trello.getCard(session.cards[session.index].id);
  const updatedActionDesc = appendLogLine(
    actionCard.desc ?? "",
    `${date}: no progress`
  );
  await trello.updateCard(actionCard.id, { desc: updatedActionDesc });

  session.noProgressCount += 1;
  setReviewSession(session);
  if (session.messageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "No progress recorded",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `No progress recorded for *${actionCard.name}*`,
          },
        },
      ],
    });
  }
  await advanceReview({ session, client });
});

app.action("review_skip", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  session.skipCount += 1;
  setReviewSession(session);
  if (session.messageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "Skipped",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Skipped." },
        },
      ],
    });
  }
  await advanceReview({ session, client });
});

app.action("review_stop", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  clearReviewSession(session.userId);
  if (session.messageTs) {
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: "Review stopped.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Review stopped." },
        },
      ],
    });
  }
});

app.action("review_done_next_yes", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  const doneSession = getDoneSession(body.user.id);
  if (
    !session ||
    !doneSession ||
    session.channelId !== body.channel?.id ||
    !session.messageTs
  ) {
    return;
  }

  const nextText = doneSession.nextItemName ?? "";
  await createNextActionForProject({
    userId: doneSession.userId,
    nextActionText: nextText.replace(/^\[NEXT\]\s*/, ""),
    useExistingChecklistItem: doneSession.forceNewChecklistItem !== true,
  });

  clearDoneSession(doneSession.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "✅ Next action created.",
  });
});

app.action("review_done_next_pick", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  if (!session || session.channelId !== body.channel?.id) {
    return;
  }
  if ("trigger_id" in body && typeof body.trigger_id === "string") {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "review_done_next_action_modal",
        title: { type: "plain_text", text: "Next Action" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "next_action_block",
            label: { type: "plain_text", text: "Next Action" },
            element: {
              type: "plain_text_input",
              action_id: "next_action_input",
            },
          },
          {
            type: "input",
            block_id: "notes_block",
            optional: true,
            label: { type: "plain_text", text: "Notes" },
            element: {
              type: "plain_text_input",
              action_id: "notes_input",
              multiline: true,
            },
          },
        ],
      },
    });
  }
});

app.action("review_done_next_suggest", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  const doneSession = getDoneSession(body.user.id);
  if (
    !session ||
    !doneSession ||
    session.channelId !== body.channel?.id ||
    !session.messageTs
  ) {
    return;
  }

  doneSession.forceNewChecklistItem = true;
  setDoneSession(doneSession);

  const projectCard = await trello.getCard(doneSession.projectCardId);
  const checklistItems = (
    await trello.getChecklistItems(doneSession.checklistId)
  )
    .filter((item) => item.state === "incomplete")
    .map((item) => item.name);
  const recentLogs = (parseFooter(projectCard.desc ?? "")?.log ?? []).slice(-5);
  await showAiNextActionSuggestions({
    session: doneSession,
    channelId: session.channelId,
    client,
    projectCard: {
      name: projectCard.name,
      desc: stripFooter(projectCard.desc ?? ""),
    },
    checklistItems,
    recentLogs,
    completedActionTitle: doneSession.actionCardName,
  });
});

app.action("review_done_next_notnow", async ({ ack, body, client }) => {
  await ack();
  const session = getReviewSession(body.user.id);
  const doneSession = getDoneSession(body.user.id);
  if (
    !session ||
    !doneSession ||
    session.channelId !== body.channel?.id ||
    !session.messageTs
  ) {
    return;
  }
  session.suppressNextActionPrompt = true;
  setReviewSession(session);
  await logNoNextActionDuringReview({ doneSession });
  clearDoneSession(doneSession.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "Okay, not now.",
  });
});

app.view("review_done_next_action_modal", async ({ ack, body, view, client }) => {
  const nextAction =
    view.state.values["next_action_block"]?.["next_action_input"]?.value ?? "";
  if (nextAction.trim().length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        next_action_block: "Next action is required.",
      },
    });
    return;
  }

  await ack({ response_action: "clear" });

  const notes =
    view.state.values["notes_block"]?.["notes_input"]?.value ?? "";

  const session = getReviewSession(body.user.id);
  const doneSession = getDoneSession(body.user.id);
  if (!session || !doneSession || !session.messageTs) {
    return;
  }

  await createNextActionForProject({
    userId: doneSession.userId,
    nextActionText: nextAction,
    notes,
    useExistingChecklistItem: doneSession.forceNewChecklistItem !== true,
  });

  clearDoneSession(doneSession.userId);
  await finalizeNextActionMessage({
    userId: session.userId,
    client,
    channelId: session.channelId,
    messageTs: session.messageTs,
    text: "✅ Next action created.",
  });
});

async function renderHomeScreenForUser(options: {
  userId: string;
  channelId: string;
  messageTs?: string;
  client: App["client"];
  includeStatus?: boolean;
}): Promise<string> {
  const today = formatDateYYYYMMDD(new Date());
  const clarifySession = getSession(options.userId);
  const reviewSession = getReviewSession(options.userId);

  const clarifyStatus = clarifySession
    ? `Clarify: active (${clarifySession.index + 1} of ${clarifySession.cards.length})`
    : "Clarify: inactive";
  const reviewStatus = reviewSession
    ? `Review: active (${reviewSession.index + 1} of ${reviewSession.cards.length})`
    : "Review: inactive";

  let lastBriefDate = "none";
  let inboxCountText = "unknown";
  if (options.includeStatus) {
    const history = readBriefHistory();
    const entry = history[options.userId];
    if (entry?.date) {
      lastBriefDate = entry.date;
    }

    const inboxCards = await trello.getCardsInList(
      env.TRELLO_INBOX_RAW_LIST_ID,
      { limit: 100 }
    );
    inboxCountText = String(inboxCards.length);
  }

  const { blocks, text } = renderHomeScreen({
    dateText: today,
    clarifyStatus,
    reviewStatus,
    lastBriefDate,
    inboxCountText,
  });

  if (options.messageTs) {
    await updateSessionMessage(
      options.client,
      options.channelId,
      options.messageTs,
      blocks,
      text
    );
    return options.messageTs;
  }

  const posted = await options.client.chat.postMessage({
    channel: options.channelId,
    text,
    blocks,
  });
  const messageTs = posted.ts as string;
  setHomeState(options.userId, options.channelId, messageTs);
  return messageTs;
}

app.command("/home", async ({ ack, command, respond, client }) => {
  await ack();

  if (
    !command.channel_id.startsWith("D") &&
    command.channel_name !== "directmessage"
  ) {
    await respond("Please run /home in a DM with me.");
    return;
  }

  const state = readHomeState();
  const existing = state[command.user_id];
  let currentMessageTs: string | undefined;
  let currentChannelId: string | undefined;
  if (existing) {
    try {
      currentMessageTs = await renderHomeScreenForUser({
        userId: command.user_id,
        channelId: existing.channelId,
        messageTs: existing.messageTs,
        client,
        includeStatus: true,
      });
      currentChannelId = existing.channelId;
    } catch {
      // fall through to create new
    }
  }

  if (!currentMessageTs) {
    currentMessageTs = await renderHomeScreenForUser({
      userId: command.user_id,
      channelId: command.channel_id,
      client,
      includeStatus: true,
    });
    currentChannelId = command.channel_id;
  }

  if (currentMessageTs && currentChannelId) {
    const pinnedMessageTs = existing?.pinnedMessageTs;
    await pinMessage(currentChannelId, currentMessageTs);
    if (pinnedMessageTs && pinnedMessageTs !== currentMessageTs) {
      await unpinMessage(currentChannelId, pinnedMessageTs);
    }
    setHomeState(
      command.user_id,
      currentChannelId,
      currentMessageTs,
      currentMessageTs
    );
  }
});

app.action("home_brief", async ({ ack, body, client }) => {
  await ack();
  await runBrief({
    userId: body.user.id,
    channelId: body.user.id,
    triggerId: "trigger_id" in body ? body.trigger_id : undefined,
    client,
  });
});

app.action("home_clarify", async ({ ack, body, client }) => {
  await ack();
  await startClarify({
    userId: body.user.id,
    channelId: body.channel?.id ?? body.user.id,
    client,
  });
});

app.action("home_review", async ({ ack, body, client }) => {
  await ack();
  await startReview({
    userId: body.user.id,
    channelId: body.channel?.id ?? body.user.id,
    client,
  });
});

app.action("home_status", async ({ ack, body, client }) => {
  await ack();
  const state = readHomeState();
  const existing = state[body.user.id];
  if (!existing) {
    return;
  }
  await renderHomeScreenForUser({
    userId: body.user.id,
    channelId: existing.channelId,
    messageTs: existing.messageTs,
    client,
    includeStatus: true,
  });
});

app.action("home_help", async ({ ack, body, client }) => {
  await ack();
  if (!("trigger_id" in body) || typeof body.trigger_id !== "string") {
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "home_help_modal",
      title: { type: "plain_text", text: "JR Bot Help" },
      close: { type: "plain_text", text: "Close" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "*Capture*\nDM the bot and it will react ✅ on success.\n\n" +
              "*When to run*\nMorning: /brief\nEnd of day: /clarify then /review\n\n" +
              "*Commands*\n/home\n/brief\n/clarify\n/review\n/done <url>",
          },
        },
      ],
    },
  });
});

function openReviewProgressModal(triggerId: string) {
  return app.client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "review_progress_modal",
      title: { type: "plain_text", text: "Log Progress" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "hours_block",
          label: { type: "plain_text", text: "Hours worked today" },
          element: {
            type: "plain_text_input",
            action_id: "hours_input",
            placeholder: { type: "plain_text", text: "1.5" },
          },
        },
        {
          type: "input",
          block_id: "notes_block",
          optional: true,
          label: { type: "plain_text", text: "Notes" },
          element: {
            type: "plain_text_input",
            action_id: "notes_input",
            multiline: true,
          },
        },
      ],
    },
  });
}

app.view("review_progress_modal", async ({ ack, body, view, client }) => {
  const hoursRaw =
    view.state.values["hours_block"]?.["hours_input"]?.value ?? "";
  const hours = Number(hoursRaw);
  const quarter = Math.round(hours * 4) / 4;
  if (!hoursRaw || Number.isNaN(hours) || Math.abs(quarter - hours) > 0.001) {
    await ack({
      response_action: "errors",
      errors: {
        hours_block: "Enter hours in 0.25 increments (e.g., 0.5, 1.25).",
      },
    });
    return;
  }

  await ack({ response_action: "clear" });

  const notes =
    view.state.values["notes_block"]?.["notes_input"]?.value ?? "";

  const session = getReviewSession(body.user.id);
  if (!session) {
    return;
  }

  const status = session.pendingStatus ?? "progress";
  await logProgressToCards({
    actionCardId: session.cards[session.index].id,
    status,
    hours,
    notes,
  });

  session.totalHours = Math.round((session.totalHours + hours) * 100) / 100;
  if (status === "progress") {
    session.progressCount += 1;
  } else {
    session.blockedCount += 1;
  }
  session.pendingStatus = undefined;
  setReviewSession(session);

  if (session.messageTs) {
    const label = status === "progress" ? "Progress logged" : "Blocked logged";
    await client.chat.update({
      channel: session.channelId,
      ts: session.messageTs,
      text: label,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${label} for *${session.cards[session.index].url}*`,
          },
        },
      ],
    });
  }

  await advanceReview({ session, client });
});

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  try {
    await app.stop();
  } catch (error) {
    console.error("Error stopping Slack app", error);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

(async () => {
  await app.start();
  server.listen(env.PORT, () => {
    console.log(`✅ Health server listening on :${env.PORT}`);
    console.log(
      `Startup: env=${process.env.NODE_ENV ?? "development"} port=${env.PORT} ai=${env.AI_ENABLED ? "on" : "off"} model=${env.GEMINI_MODEL}`
    );
  });
  console.log("⚡️ Slack bot is running in Socket Mode");
})();
