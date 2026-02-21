import "dotenv/config";
import { loadEnv } from "../env";
import { createTrelloClient } from "../trello/client";

const env = loadEnv(process.env);

const trello = createTrelloClient({
  apiKey: env.TRELLO_API_KEY,
  apiToken: env.TRELLO_API_TOKEN,
  inboxListId: env.TRELLO_INBOX_LIST_ID,
});

async function run() {
  const cards = await trello.getCardsInList(env.TRELLO_INBOX_RAW_LIST_ID, {
    limit: 5,
  });

  cards.forEach((card) => {
    const shortId = card.id.slice(0, 6);
    console.log(`${card.name} | ${shortId} | ${card.url}`);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
