import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const listSchema = z.object({
  processing: z.string().min(1),
  actionItems: z.string().min(1),
  inProgress: z.string().min(1),
  projects: z.string().min(1),
  waitingFor: z.string().min(1),
  maybeSomeday: z.string().min(1),
  reference: z.string().min(1),
  doneWeekly: z.string().min(1),
});

const boardSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  boardId: z.string().min(1),
  lists: listSchema,
});

const boardsConfigSchema = z.object({
  boards: z.array(boardSchema).min(1),
});

export type BoardsConfig = z.infer<typeof boardsConfigSchema>;

export function loadBoardsConfig(): BoardsConfig {
  const configPath = join(process.cwd(), "config", "boards.json");
  let raw: unknown;
  try {
    const contents = readFileSync(configPath, "utf-8");
    raw = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load boards config: ${message}`);
  }

  const parsed = boardsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid boards config: ${issues}`);
  }

  return parsed.data;
}

export function getBoardByKey(config: BoardsConfig, key: string) {
  return config.boards.find((board) => board.key === key);
}
