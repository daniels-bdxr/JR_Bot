import "dotenv/config";
import { loadBoardsConfig } from "../gtd/boards";
import { generateStructured } from "../ai/structured";
import { ClarifySuggestionSchema } from "../ai/schemas";
import { buildClarifyPrompt } from "../ai/prompts/clarifyPrompt";

async function run() {
  const boards = loadBoardsConfig().boards.map((b) => ({
    key: b.key === "personal" ? "growth" : b.key === "ai_xr" ? "embxr" : "bdxr",
    name: b.name,
  }));

  const { system, user } = buildClarifyPrompt({
    name: "Plan quarterly OKR review",
    descSnippet: "Need to compile progress and present to leadership.",
    slack: { user: "U123", channel: "D123", ts: "1699999999.000100" },
    boards,
    priorities: ["P1 – Focus", "P2 – Important", "P3 – Backlog"],
    energies: ["⚡ 5–10 min", "🧠 Deep", "🔋 Low Energy"],
    flags: ["⛔ Blocked", "🕒 Follow-up", "📅 Deadline"],
  });

  const result = await generateStructured({
    system,
    user,
    schema: ClarifySuggestionSchema,
    timeoutMs: 10000,
    maxRetries: 2,
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(JSON.stringify(result.data, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
