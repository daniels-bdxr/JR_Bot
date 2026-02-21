import { z } from "zod";

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
  PORT: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return 3000;
      }
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }, z.number().int().positive())
    .default(3000),
  TRELLO_API_KEY: z.string().min(1, "TRELLO_API_KEY is required"),
  TRELLO_API_TOKEN: z.string().min(1, "TRELLO_API_TOKEN is required"),
  TRELLO_INBOX_LIST_ID: z
    .string()
    .min(1, "TRELLO_INBOX_LIST_ID is required"),
  TRELLO_INBOX_RAW_LIST_ID: z
    .string()
    .min(1, "TRELLO_INBOX_RAW_LIST_ID is required"),
  TRELLO_INBOX_QUICK_LIST_ID: z
    .string()
    .min(1, "TRELLO_INBOX_QUICK_LIST_ID is required"),
  TRELLO_INBOX_REFERENCE_LIST_ID: z
    .string()
    .min(1, "TRELLO_INBOX_REFERENCE_LIST_ID is required"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return "gemini-2.5-flash";
      }
      return value;
    }, z.string().min(1))
    .default("gemini-2.5-flash"),
  AI_ENABLED: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return true;
      }
      if (typeof value === "boolean") {
        return value;
      }
      const normalized = String(value).toLowerCase().trim();
      if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
      }
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      return value;
    }, z.boolean())
    .default(true),
  AI_LOG_LEVEL: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") {
        return "basic";
      }
      return String(value).toLowerCase().trim();
    }, z.enum(["basic", "none"]))
    .default("basic"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(rawEnv: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${errors}`);
  }

  return parsed.data;
}
