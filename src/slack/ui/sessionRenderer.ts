import type { Block, KnownBlock } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

export type ClarifyRenderState = {
  blocks: Array<KnownBlock | Block>;
  lastFiled?: { board: string; list: string; labels: string[] };
};

export type ReviewRenderState = {
  index: number;
  total: number;
  card: { name: string; url: string };
};

export function renderClarifySession(
  state: ClarifyRenderState
): Array<KnownBlock | Block> {
  if (!state.lastFiled) {
    return state.blocks;
  }

  const labelText =
    state.lastFiled.labels.length > 0 ? state.lastFiled.labels.join(", ") : "None";
  const filedBlock: Array<KnownBlock | Block> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ Filed\nBoard: ${state.lastFiled.board} | List: ${state.lastFiled.list} | Labels: ${labelText}`,
      },
    },
    {
      type: "divider",
    },
  ];

  return [...filedBlock, ...state.blocks];
}

export function renderReviewSession(
  state: ReviewRenderState
): Array<KnownBlock | Block> {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Review — (${state.index} of ${state.total})`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${state.card.name}*\n${state.card.url}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Done" },
          action_id: "review_done",
          value: "done",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Progress" },
          action_id: "review_progress",
          value: "progress",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "No progress" },
          action_id: "review_noprogress",
          value: "noprogress",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Blocked" },
          action_id: "review_blocked",
          value: "blocked",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          action_id: "review_skip",
          value: "skip",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          action_id: "review_stop",
          value: "stop",
          style: "danger",
        },
      ],
    },
  ];
}

export async function updateSessionMessage(
  client: WebClient,
  channelId: string,
  messageTs: string,
  blocks: Array<KnownBlock | Block>,
  textFallback: string
): Promise<void> {
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: textFallback,
    blocks,
  });
}
