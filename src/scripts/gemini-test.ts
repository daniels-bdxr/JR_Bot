import "dotenv/config";
import { generateText } from "../ai/geminiClient";

async function run() {
  const result = await generateText("Return the word OK.");
  console.log(result);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
