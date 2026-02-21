import { z } from "zod";

function normalizeDash(value: string): string {
  return value.replace(/\u2013|\u2014/g, "-");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePriority(value: string): string {
  return normalizeWhitespace(normalizeDash(value));
}

function normalizeEnergy(value: string): string {
  return normalizeWhitespace(normalizeDash(value));
}

function normalizeFlag(value: string): string {
  return normalizeWhitespace(normalizeDash(value));
}

const priorityValues = ["P1 – Focus", "P2 – Important", "P3 – Backlog"] as const;
const energyValues = ["⚡ 5–10 min", "🧠 Deep", "🔋 Low Energy"] as const;
const boardValues = ["growth", "embxr", "bdxr", "inbox_reference"] as const;
const itemTypeValues = ["action", "project", "reference", "someday"] as const;
const flagValues = ["⛔ Blocked", "🕒 Follow-up", "📅 Deadline"] as const;

const priorityEnum = z.enum(priorityValues);
const energyEnum = z.enum(energyValues);
const boardEnum = z.enum(boardValues);
const itemTypeEnum = z.enum(itemTypeValues);
const flagEnum = z.enum(flagValues);

export type ClarifySuggestion = {
  confidence: number;
  rationale: string;
  boardKey: (typeof boardValues)[number] | null;
  itemType: (typeof itemTypeValues)[number] | null;
  nextAction: string | null;
  priority: (typeof priorityValues)[number] | null;
  energy: (typeof energyValues)[number] | null;
  flags: Array<(typeof flagValues)[number]>;
  deadline: string | null;
};

function coerceEnum<T extends string>(value: string, allowed: readonly T[]): T | null {
  const match = allowed.find((entry) => entry === value);
  return match ?? null;
}

export const ClarifySuggestionSchema: z.ZodType<
  ClarifySuggestion,
  z.ZodTypeDef,
  unknown
> = z.object({
  confidence: z.preprocess((value) => {
    if (value === null || value === undefined || value === "") return 0;
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(num)) return 0;
    return num;
  }, z.number().min(0).max(1)),
  rationale: z
    .string()
    .transform((v) => normalizeWhitespace(v).slice(0, 140)),
  boardKey: z
    .preprocess((value) => {
      if (value === null || value === undefined) {
        return null;
      }
      const raw = String(value).trim();
      if (raw === "personal") return "growth";
      if (raw === "ai_xr") return "embxr";
      if (raw === "bd_xr") return "bdxr";
      if (raw === "inbox_reference") return "inbox_reference";
      return raw;
    }, z.string().nullable())
    .transform((value) => (value ? coerceEnum(value, boardEnum.options) : null))
    .nullable(),
  itemType: z.preprocess((value) => {
    if (value === null || value === undefined) {
      return null;
    }
    const raw = String(value).trim();
    if (raw === "maybe") return "someday";
    return raw;
  }, z.string().nullable())
    .transform((value) => (value ? coerceEnum(value, itemTypeEnum.options) : null))
    .nullable(),
  nextAction: z
    .preprocess((value) => {
      if (value === null || value === undefined || value === "") return null;
      return String(value);
    }, z.string().transform((v) => v.slice(0, 120)).nullable()),
  priority: z.preprocess((value) => {
    if (value === null || value === undefined) return null;
    const raw = normalizePriority(String(value));
    if (raw === "P1 - Focus") return "P1 – Focus";
    if (raw === "P2 - Important") return "P2 – Important";
    if (raw === "P3 - Backlog") return "P3 – Backlog";
    return raw;
  }, z.string().nullable())
    .transform((value) => (value ? coerceEnum(value, priorityEnum.options) : null))
    .nullable(),
  energy: z.preprocess((value) => {
    if (value === null || value === undefined) return null;
    const raw = normalizeEnergy(String(value));
    if (raw === "⚡<30 min") return "⚡ 5–10 min";
    return raw;
  }, z.string().nullable())
    .transform((value) => (value ? coerceEnum(value, energyEnum.options) : null))
    .nullable(),
  flags: z
    .preprocess((value) => {
      if (value === null || value === undefined || value === "") return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        const raw = normalizeFlag(value);
        if (raw.toLowerCase() === "none" || raw.toLowerCase() === "null") {
          return [];
        }
        return [raw];
      }
      return [];
    }, z.array(z.string()))
    .transform((items) => {
      const normalized = items
        .map((item) => normalizeFlag(String(item)))
        .map((item) => {
          if (item === "Deadline") return "📅 Deadline";
          if (item === "Blocked") return "⛔ Blocked";
          if (item === "Follow-up" || item === "Follow up") return "🕒 Follow-up";
          return item;
        })
        .filter((item) => flagEnum.options.includes(item as (typeof flagValues)[number]));

      return normalized as Array<(typeof flagValues)[number]>;
    })
    .default([]),
  deadline: z
    .preprocess((value) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const raw = String(value).trim();
      const match = raw.match(/\d{4}-\d{2}-\d{2}/);
      return match ? match[0] : null;
    }, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable())
    .nullable(),
});

export type ProjectNextActionSuggestion = {
  confidence: number;
  rationale: string;
  candidates: string[];
};

export const ProjectNextActionSuggestionSchema: z.ZodType<
  ProjectNextActionSuggestion,
  z.ZodTypeDef,
  unknown
> = z.object({
  confidence: z.preprocess((value) => {
    if (value === null || value === undefined || value === "") return 0;
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(num)) return 0;
    return num;
  }, z.number().min(0).max(1)),
  rationale: z
    .string()
    .transform((v) => normalizeWhitespace(v).slice(0, 140)),
  candidates: z
    .preprocess((value) => {
      if (value === null || value === undefined) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "string") return [value];
      return [];
    }, z.array(z.string()))
    .transform((items) =>
      items
        .map((item) => normalizeWhitespace(String(item)))
        .filter((item) => item.length > 0)
        .slice(0, 3)
        .map((item) => truncateForMax(item, 120))
    )
    .default([]),
});

function truncateForMax(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, Math.max(0, max - 3)) + "...";
}
