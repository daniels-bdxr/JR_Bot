import "dotenv/config";
import { loadEnv } from "../env";
import { createTrelloClient } from "../trello/client";
import { loadBoardsConfig } from "../gtd/boards";

const env = loadEnv(process.env);
const boardsConfig = loadBoardsConfig();

const trello = createTrelloClient({
  apiKey: env.TRELLO_API_KEY,
  apiToken: env.TRELLO_API_TOKEN,
  inboxListId: env.TRELLO_INBOX_LIST_ID,
});

async function run() {
  for (const board of boardsConfig.boards) {
    if (board.boardId === "REPLACE_ME") {
      console.warn(`Skipping ${board.key}: boardId is REPLACE_ME`);
      continue;
    }

    const lists = await trello.getListsOnBoard(board.boardId);
    console.log(`\n${board.key} (${board.name})`);
    lists.forEach((list) => {
      console.log(`${list.id} | ${list.name}`);
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
