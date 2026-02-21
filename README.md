# jrbot-gtd

Slack-based personal assistant bot (thin-slice). This step provides a minimal Slack DM reply bot using Slack Bolt in Socket Mode.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file using `.env.example` and fill in values.

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
