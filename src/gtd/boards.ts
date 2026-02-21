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
  let raw: unknown;

  // 1️⃣ Prefer environment-based config (Railway / production)
  if (process.env.BOARDS_CONFIG_JSON) {
    try {
      raw = JSON.parse(process.env.BOARDS_CONFIG_JSON);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid BOARDS_CONFIG_JSON (must be valid JSON): ${message}`
      );
    }
  } else {
    // 2️⃣ Fallback to file-based config (local dev)
    const configPath =
      process.env.BOARDS_CONFIG_PATH ??
      join(process.cwd(), "config", "boards.json");

    try {
      const contents = readFileSync(configPath, "utf-8");
      raw = JSON.parse(contents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load boards config. Provide BOARDS_CONFIG_JSON or ensure file exists at ${configPath}. ${message}`
      );
    }
  }

  // 3️⃣ Validate via Zod
  const parsed = boardsConfigSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `Boards config validation failed:\n${parsed.error.issues
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }

  return parsed.data;
}

export function getBoardByKey(config: BoardsConfig, key: string) {
  return config.boards.find((board) => board.key === key);
}
