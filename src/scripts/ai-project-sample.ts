import "dotenv/config";
import { generateStructured } from "../ai/structured";
import {
  ProjectNextActionSuggestion,
  ProjectNextActionSuggestionSchema,
} from "../ai/schemas";
import { buildProjectNextActionPrompt } from "../ai/prompts/projectNextActionPrompt";

async function run() {
  const { system, user } = buildProjectNextActionPrompt({
    projectCard: {
      name: "Launch Q2 Partner Program",
      desc: "Coordinate partners, finalize incentives, and prep announcement.",
    },
    checklistItems: [
      "[NEXT] Draft partner outreach email",
      "Review incentive structure with finance",
      "Finalize launch timeline",
    ],
    recentLogs: [
      "2026-02-10: Met with finance about incentive ranges.",
      "2026-02-12: Drafted partner list.",
    ],
    completedActionTitle: "Finalize partner list for outreach",
  });

  const result = await generateStructured<ProjectNextActionSuggestion>({
    system,
    user,
    schema: ProjectNextActionSuggestionSchema,
    timeoutMs: 10000,
    maxRetries: 1,
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
