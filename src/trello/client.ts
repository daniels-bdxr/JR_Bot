import { TrelloCreateCardResponse, TrelloCard } from "./types";

export type TrelloClientConfig = {
  apiKey: string;
  apiToken: string;
  inboxListId: string;
};

export type TrelloListCard = {
  id: string;
  name: string;
  desc: string;
  url: string;
  due?: string | null;
  labels?: Array<{ name: string }>;
};

export type TrelloCardDetail = {
  id: string;
  name: string;
  desc: string;
  url: string;
  idBoard: string;
  idList: string;
};

function buildAuthQuery(config: TrelloClientConfig): URLSearchParams {
  const params = new URLSearchParams();
  params.set("key", config.apiKey);
  params.set("token", config.apiToken);
  return params;
}

export function createTrelloClient(config: TrelloClientConfig) {
  async function createInboxCard(
    name: string,
    desc?: string
  ): Promise<TrelloCard> {
    return createCardInList(config.inboxListId, name, desc);
  }

  async function deleteCard(cardId: string): Promise<void> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}`);
    const params = buildAuthQuery(config);
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "DELETE" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello delete card failed: ${response.status} ${response.statusText} - ${body}`
      );
    }
  }

  async function getCardsInList(
    listId: string,
    opts?: { limit?: number }
  ): Promise<TrelloListCard[]> {
    const url = new URL(`https://api.trello.com/1/lists/${listId}/cards`);
    const params = buildAuthQuery(config);
    params.set("fields", "id,name,desc,url,due,labels");
    if (opts?.limit) {
      params.set("limit", String(opts.limit));
    }
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello get cards failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as TrelloListCard[];
    const sorted = [...data].sort((a, b) => {
      const aTime = parseInt(a.id.slice(0, 8), 16);
      const bTime = parseInt(b.id.slice(0, 8), 16);
      return bTime - aTime;
    });

    return sorted;
  }

  async function getCard(
    cardIdOrShortLink: string
  ): Promise<TrelloCardDetail> {
    const url = new URL(`https://api.trello.com/1/cards/${cardIdOrShortLink}`);
    const params = buildAuthQuery(config);
    params.set("fields", "id,name,desc,url,idBoard,idList");
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello get card failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as TrelloCardDetail;
    return data;
  }

  async function moveCardToList(
    cardId: string,
    listId: string,
    boardId?: string
  ): Promise<void> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}`);
    const params = buildAuthQuery(config);
    params.set("idList", listId);
    if (boardId) {
      params.set("idBoard", boardId);
    }
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "PUT" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello move card failed: ${response.status} ${response.statusText} - ${body}`
      );
    }
  }

  async function updateCard(
    cardId: string,
    patch: { name?: string; desc?: string; due?: string | null }
  ): Promise<void> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}`);
    const params = buildAuthQuery(config);
    if (patch.name !== undefined) {
      params.set("name", patch.name);
    }
    if (patch.desc !== undefined) {
      params.set("desc", patch.desc);
    }
    if (patch.due !== undefined) {
      params.set("due", patch.due === null ? "" : patch.due);
    }
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "PUT" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello update card failed: ${response.status} ${response.statusText} - ${body}`
      );
    }
  }

  async function addLabelByName(
    cardId: string,
    boardId: string,
    labelName: string
  ): Promise<boolean> {
    const labelsUrl = new URL(
      `https://api.trello.com/1/boards/${boardId}/labels`
    );
    const labelParams = buildAuthQuery(config);
    labelParams.set("fields", "id,name");
    labelsUrl.search = labelParams.toString();

    const labelResponse = await fetch(labelsUrl.toString(), { method: "GET" });
    if (!labelResponse.ok) {
      const body = await labelResponse.text();
      throw new Error(
        `Trello get labels failed: ${labelResponse.status} ${labelResponse.statusText} - ${body}`
      );
    }

    const labels = (await labelResponse.json()) as Array<{
      id: string;
      name: string;
    }>;
    const match = labels.find((label) => label.name === labelName);
    if (!match) {
      return false;
    }

    const addUrl = new URL(`https://api.trello.com/1/cards/${cardId}/idLabels`);
    const addParams = buildAuthQuery(config);
    addParams.set("value", match.id);
    addUrl.search = addParams.toString();

    const addResponse = await fetch(addUrl.toString(), { method: "POST" });
    if (!addResponse.ok) {
      const body = await addResponse.text();
      throw new Error(
        `Trello add label failed: ${addResponse.status} ${addResponse.statusText} - ${body}`
      );
    }

    return true;
  }

  async function getChecklistsOnCard(
    cardId: string
  ): Promise<Array<{ id: string; name: string }>> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}/checklists`);
    const params = buildAuthQuery(config);
    params.set("fields", "id,name");
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello get checklists failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as Array<{ id: string; name: string }>;
    return data;
  }

  async function createChecklist(
    cardId: string,
    name: string
  ): Promise<{ id: string }> {
    const url = new URL(`https://api.trello.com/1/cards/${cardId}/checklists`);
    const params = buildAuthQuery(config);
    params.set("name", name);
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "POST" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello create checklist failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as { id: string };
    return { id: data.id };
  }

  async function addChecklistItem(
    checklistId: string,
    name: string
  ): Promise<{ id: string }> {
    const url = new URL(
      `https://api.trello.com/1/checklists/${checklistId}/checkItems`
    );
    const params = buildAuthQuery(config);
    params.set("name", name);
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "POST" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello add checklist item failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as { id: string };
    return { id: data.id };
  }

  async function updateChecklistItemState(
    cardId: string,
    itemId: string,
    state: "complete" | "incomplete"
  ): Promise<void> {
    const url = new URL(
      `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`
    );
    const params = buildAuthQuery(config);
    params.set("state", state);
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "PUT" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello update checklist item failed: ${response.status} ${response.statusText} - ${body}`
      );
    }
  }

  async function updateChecklistItemName(
    cardId: string,
    itemId: string,
    name: string
  ): Promise<void> {
    const url = new URL(
      `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`
    );
    const params = buildAuthQuery(config);
    params.set("name", name);
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "PUT" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello update checklist item name failed: ${response.status} ${response.statusText} - ${body}`
      );
    }
  }

  async function getChecklistItems(
    checklistId: string
  ): Promise<Array<{ id: string; name: string; state: "complete" | "incomplete" }>> {
    const url = new URL(
      `https://api.trello.com/1/checklists/${checklistId}/checkItems`
    );
    const params = buildAuthQuery(config);
    params.set("fields", "id,name,state");
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello get checklist items failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as Array<{
      id: string;
      name: string;
      state: "complete" | "incomplete";
    }>;
    return data;
  }

  async function createCardInList(
    listId: string,
    name: string,
    desc?: string
  ): Promise<TrelloCard> {
    const url = new URL("https://api.trello.com/1/cards");
    const params = buildAuthQuery(config);
    params.set("idList", listId);
    params.set("name", name);
    if (desc) {
      params.set("desc", desc);
    }
    url.search = params.toString();

    const response = await fetch(url.toString(), { method: "POST" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Trello create card failed: ${response.status} ${response.statusText} - ${body}`
      );
    }

    const data = (await response.json()) as TrelloCreateCardResponse;
    if (!data?.id || !data?.url) {
      throw new Error("Trello create card response missing id or url");
    }

    return { id: data.id, url: data.url };
  }

  return {
    createInboxCard,
    createCardInList,
    deleteCard,
    getCardsInList,
    moveCardToList,
    updateCard,
    addLabelByName,
    getChecklistsOnCard,
    createChecklist,
    addChecklistItem,
    updateChecklistItemState,
    updateChecklistItemName,
    getChecklistItems,
    getCard,
    async getListsOnBoard(boardId: string): Promise<Array<{ id: string; name: string }>> {
      const url = new URL(`https://api.trello.com/1/boards/${boardId}/lists`);
      const params = buildAuthQuery(config);
      params.set("fields", "id,name");
      url.search = params.toString();

      const response = await fetch(url.toString(), { method: "GET" });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Trello get lists failed: ${response.status} ${response.statusText} - ${body}`
        );
      }

      const data = (await response.json()) as Array<{ id: string; name: string }>;
      return data;
    },
  };
}
