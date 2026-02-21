import { z } from "zod";

const schema = z.object({
  action: z.string(),
  confidence: z.number().min(0).max(1),
});

const mockedJson = '{"action":"ok","confidence":0.8}';

const parsed = JSON.parse(mockedJson);
const result = schema.safeParse(parsed);

if (!result.success) {
  console.error("validation failed");
  process.exit(1);
}

console.log("validation ok");
