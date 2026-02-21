import "dotenv/config";
import { loadEnv } from "../env";
import { createTrelloClient } from "../trello/client";

const env = loadEnv(process.env);

const trello = createTrelloClient({
  apiKey: env.TRELLO_API_KEY,
  apiToken: env.TRELLO_API_TOKEN,
  inboxListId: env.TRELLO_INBOX_LIST_ID,
});

const timestamp = new Date().toISOString();
const title = `Smoke Test - ${timestamp}`;

async function run() {
  const card = await trello.createInboxCard(title);
  console.log(card.url);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
