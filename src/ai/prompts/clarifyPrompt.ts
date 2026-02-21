export type ClarifyPromptInput = {
  name: string;
  descSnippet: string;
  slack: { user?: string; channel?: string; ts?: string };
  boards: Array<{ key: string; name: string }>;
  priorities: string[];
  energies: string[];
  flags: string[];
};

export function buildClarifyPrompt(input: ClarifyPromptInput): {
  system: string;
  user: string;
} {
  const system = [
    "You are assisting with GTD-style clarification.",
    "Return only JSON matching the provided schema.",
    "If unsure, set fields to null and lower confidence.",
    "Rationale must be one line, max 140 chars.",
    "Respect Trello as source of truth; do not invent details.",
  ].join("\n");

  const boards = input.boards
    .map((b) => `- ${b.key}: ${b.name}`)
    .join("\n");
  const priorities = input.priorities.map((p) => `- ${p}`).join("\n");
  const energies = input.energies.map((e) => `- ${e}`).join("\n");
  const flags = input.flags.map((f) => `- ${f}`).join("\n");

  const user = [
    "Captured item:",
    `Name: ${input.name}`,
    `Description snippet: ${input.descSnippet}`,
    `Slack: user=${input.slack.user ?? "unknown"}, channel=${input.slack.channel ?? "unknown"}, ts=${input.slack.ts ?? "unknown"}`,
    "",
    "Available board keys:",
    boards,
    "",
    "Allowed labels:",
    "Priority:",
    priorities,
    "Energy:",
    energies,
    "Flags:",
    flags,
    "",
    "Rules:",
    "- Suggest boardKey and itemType only if confident.",
    "- If item is a project, propose a concise nextAction.",
    "- Deadline only if explicitly implied; use YYYY-MM-DD.",
    "",
    "Output schema (JSON object with these keys):",
    "confidence, rationale, boardKey, itemType, nextAction, priority, energy, flags, deadline",
    "Use null when unknown. flags is always an array (possibly empty).",
    "",
    "Return only JSON matching schema.",
  ].join("\n");

  return { system, user };
}
