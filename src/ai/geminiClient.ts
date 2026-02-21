import { GoogleGenAI } from "@google/genai";
import { loadEnv } from "../env";

const env = loadEnv(process.env);
const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export function getGeminiModelId(): string {
  return env.GEMINI_MODEL;
}

export async function generateText(prompt: string): Promise<string> {
  const response = await client.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return response.text ?? "";
}
