# Deployment Guide (GitHub + Railway)

This project is designed to run in Socket Mode, so it does not need a public HTTP endpoint for Slack events. The `/health` endpoint is for your own monitoring only.

## 1) Push to GitHub

1. Create a new GitHub repo (empty).
2. From this project directory:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin <YOUR_GITHUB_REPO_URL>
   git push -u origin main
   ```

## 2) Railway Setup

1. Create a new Railway project.
2. Choose **Deploy from GitHub Repo** and select your repo.
3. In Railway settings:
   - **Build Command**: `npm run build`
   - **Start Command**: `npm run start`
   - **Root Directory**: repo root
4. Add environment variables (see checklist below).

## 3) Env Var Checklist

Required:
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `PORT` (Railway will supply or you can set `3000`)
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

Optional:
- None (all listed above are required by the app’s env validation).

## 4) Slack App Settings

- Socket Mode enabled.
- Bot Token Scopes:
  `app_mentions:read`, `channels:history`, `groups:history`, `im:history`,
  `mpim:history`, `chat:write`, `reactions:write`, `pins:write`
- Slash commands created and installed:
  - `/home`
  - `/brief`
  - `/clarify`
  - `/review`
  - `/done`
  - `/jrbot-verify`
  - `/ai-status`

## 5) Verify Deployment

1. Railway logs show: `⚡️ Slack bot is running in Socket Mode`
2. Health check:
   ```bash
   curl https://<your-railway-domain>/health
   ```
3. DM the bot in Slack; it should react ✅ on capture.
