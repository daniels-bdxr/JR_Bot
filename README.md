# jrbot-gtd

Slack-based personal assistant bot (thin-slice) that captures Slack DMs into Trello and guides clarification/review. It is a reliable capture-and-integration service designed to become the foundation for later GTD/AI layers.

## How It Works (System Overview)

**Core flow**
- **Capture**: DM the bot → it creates a Trello card in the Inbox list and reacts ✅ on success.
- **Clarify**: `/clarify` walks through items in the Raw Inbox using a single interactive session message.
- **File**: Clarify decisions move cards to the correct list/board and append a structured footer to Trello.
- **Brief**: `/brief` summarizes action items across boards each morning.
- **Review**: `/review` walks the day’s selected items and logs progress or completion.
- **Done**: `/done <url>` completes an action, updates project checklists, and can propose next actions.

**Data model**
- Trello is the source of truth (no DB in early phases).
- Each Trello card has a structured **JD‑BOT footer** for links/logs/metadata.
- Sessions (clarify/review/home) are in‑memory and message‑based.

**Runtime**
- Slack Bolt runs in Socket Mode.
- Express provides `/health` for monitoring.

## Gemini’s Role

Gemini is used **only for suggestions**. It does not auto‑file or auto‑create items without a user click.

Current uses:
- **Clarify suggestions**: When you click **Process**, Gemini suggests a board/type/labels/next action. You can Accept/Edit/Ignore.
- **Next‑action suggestions**: After completing a project action (via `/done` or `/review`), Gemini can propose 2–3 next actions if no active next action exists.

Safety controls:
- **AI kill switch**: `AI_ENABLED=false` disables all Gemini calls.
- **Structured output only**: Responses are validated via Zod schemas.
- **No content logging**: Only request ids + timing are logged.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file using `.env.example` and fill in values.

## Required Env Vars

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `PORT` (default `3000`)
- `TRELLO_API_KEY`
- `TRELLO_API_TOKEN`
- `TRELLO_INBOX_LIST_ID`
- `TRELLO_INBOX_RAW_LIST_ID`
- `TRELLO_INBOX_QUICK_LIST_ID`
- `TRELLO_INBOX_REFERENCE_LIST_ID`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (default `gemini-2.5-flash`)
- `AI_ENABLED` (default `true`)
- `AI_LOG_LEVEL` (default `basic`)
- `BOARDS_CONFIG_PATH` (default `config/boards.json`)

## Run

- Development (auto-reload):
  ```bash
  npm run dev
  ```

- Health check:
  ```bash
  curl http://localhost:3000/health
  ```

- Trello smoke test:
  ```bash
  npm run trello:test
  ```

- Peek Raw Inbox (newest 5):
  ```bash
  npm run inbox:peek
  ```

- Gemini smoke test:
  ```bash
  npm run gemini:test
  ```

- Build:
  ```bash
  npm run build
  ```

- Start compiled build:
  ```bash
  npm run start
  ```

## Slack App Requirements

- Enable Socket Mode.
- Add **Bot Token Scopes**: `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`, `reactions:write`, `pins:write`.
- Install the app to your workspace.
- Copy **Bot User OAuth Token** and **App-Level Token** into `.env`.

## Slash Command Setup

1. In Slack app settings, go to **Slash Commands**.
2. Create a new command named `/jrbot-verify`.
3. Description: `Verify Slack + Trello connectivity`.
4. For Socket Mode apps, you can leave the Request URL empty.
5. Reinstall the app to your workspace.

## AI Settings

- `AI_ENABLED` (default `true`): set to `false` to disable Gemini calls.
- `AI_LOG_LEVEL` (default `basic`): `basic` logs request ids + timing; `none` disables AI logs.

## AI Status Command

1. In Slack app settings, go to **Slash Commands**.
2. Create a new command named `/ai-status`.
3. Description: `Show AI status + recent call stats`.
4. For Socket Mode apps, you can leave the Request URL empty.
5. Reinstall the app to your workspace.
