import type { Block, KnownBlock } from "@slack/bolt";

export type HomeScreenState = {
  dateText: string;
  clarifyStatus: string;
  reviewStatus: string;
  lastBriefDate: string;
  inboxCountText: string;
};

export function renderHomeScreen(state: HomeScreenState): {
  text: string;
  blocks: Array<KnownBlock | Block>;
} {
  const blocks: Array<KnownBlock | Block> = [
    {
      type: "header",
      text: { type: "plain_text", text: "JR Bot — Home" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "Capture ideas anytime. Use Clarify at end of day. Use Brief in the morning. Use Review at end of day.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Morning Brief" },
          action_id: "home_brief",
          value: "brief",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Clarify Inbox" },
          action_id: "home_clarify",
          value: "clarify",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "End-of-Day Review" },
          action_id: "home_review",
          value: "review",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Show Status" },
          action_id: "home_status",
          value: "status",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Help" },
          action_id: "home_help",
          value: "help",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [
            `Today: ${state.dateText}`,
            state.clarifyStatus,
            state.reviewStatus,
            `Last brief: ${state.lastBriefDate}`,
            `Raw inbox: ${state.inboxCountText}`,
          ].join(" | "),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "📌 Pinned for quick access (Pinned items in this DM).",
        },
      ],
    },
  ];

  return {
    text: "JR Bot — Home",
    blocks,
  };
}
