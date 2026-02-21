import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { loadEnv } from "../env";
import { recordAiCall } from "./metrics";

type GenerateArgs<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
};

type GenerateResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const env = loadEnv(process.env);
const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function toJsonOnlyPrompt(user: string): string {
  return [
    "Return a single JSON object only. No markdown, no code fences, no extra text.",
    "",
    user.trim(),
  ].join("\n");
}

export async function generateStructured<T>(
  args: GenerateArgs<T>
): Promise<GenerateResult<T>> {
  const timeoutMs = args.timeoutMs ?? 20000;
  const maxRetries = args.maxRetries ?? 2;
  const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const logBasic = (message: string) => {
    if (env.AI_LOG_LEVEL === "basic") {
      console.log(message);
    }
  };

  const finalize = (ok: boolean, errorType?: string) => {
    const durationMs = Date.now() - startedAt;
    recordAiCall({
      id: requestId,
      ok,
      durationMs,
      errorType,
      timestamp: Date.now(),
    });
    logBasic(
      `ai_request id=${requestId} ms=${durationMs} ok=${ok}${errorType ? ` error=${errorType}` : ""}`
    );
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await withTimeout(
        client.models.generateContent({
          model: env.GEMINI_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: toJsonOnlyPrompt(args.user),
                },
              ],
            },
          ],
          config: {
            systemInstruction: args.system,
            responseMimeType: "application/json",
          },
        }),
        timeoutMs
      );

      const raw =
        response.text ??
        response.candidates
          ?.flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("")
          .trim() ??
        "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start >= 0 && end > start) {
          const slice = raw.slice(start, end + 1);
          try {
            parsed = JSON.parse(slice);
          } catch {
            finalize(false, "invalid_json");
            return { ok: false, error: "invalid_json" };
          }
        } else {
          finalize(false, "invalid_json");
          return { ok: false, error: "invalid_json" };
        }
      }

      const validated = args.schema.safeParse(parsed);
      if (!validated.success) {
        finalize(false, "schema_mismatch");
        return { ok: false, error: "schema_mismatch" };
      }

      finalize(true);
      return { ok: true, data: validated.data };
    } catch (error) {
      const errorType = error instanceof Error ? error.message : "unknown_error";
      if (env.AI_LOG_LEVEL === "basic") {
        console.warn(`ai_request id=${requestId} retry=${attempt} error=${errorType}`);
      }
      if (attempt < maxRetries) {
        await sleep(200 + attempt * 150);
        continue;
      }
      finalize(false, errorType);
      return { ok: false, error: errorType };
    }
  }

  finalize(false, "unknown_error");
  return { ok: false, error: "unknown_error" };
}
