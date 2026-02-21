type ProjectNextActionPromptInput = {
  projectCard: { name: string; desc: string };
  checklistItems: string[];
  recentLogs: string[];
  completedActionTitle: string;
};

export function buildProjectNextActionPrompt(
  input: ProjectNextActionPromptInput
): { system: string; user: string } {
  const system = [
    "You assist with identifying a concrete next physical action for a project.",
    "Return only JSON matching the provided schema.",
    "If unsure, return low confidence and safe, generic candidates.",
    "Rationale must be one line, max 140 chars.",
    "Candidates must be 2-3 concise action phrases, max 120 chars each.",
    "Do not include checklists or labels in candidates.",
  ].join("\n");

  const user = [
    "Project card:",
    `Name: ${input.projectCard.name}`,
    `Description: ${input.projectCard.desc}`,
    "",
    "Checklist items:",
    input.checklistItems.length > 0
      ? input.checklistItems.map((item) => `- ${item}`).join("\n")
      : "- (none)",
    "",
    "Recent logs:",
    input.recentLogs.length > 0
      ? input.recentLogs.map((line) => `- ${line}`).join("\n")
      : "- (none)",
    "",
    "Recently completed action:",
    input.completedActionTitle ? `- ${input.completedActionTitle}` : "- (unknown)",
    "",
    "Output schema keys:",
    "confidence, rationale, candidates",
    "",
    "Return only JSON matching schema.",
  ].join("\n");

  return { system, user };
}
