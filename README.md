# Browser AI

Automates comcheck creation on Comdata and exposes it through a Slack bot persona named "Nikola" powered by Claude API.

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials (see Environment Variables below)

# 3. Run in development (headed browser)
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in all values:

| Variable | Required | Description |
|----------|----------|-------------|
| `COMDATA_USERNAME` | Yes | Comdata login username |
| `COMDATA_PASSWORD` | Yes | Comdata login password |
| `COMDATA_URL` | No | Comdata URL (default: `https://www.comdata.com`) |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | Slack app-level token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack signing secret |
| `SLACK_CHANNEL_ID` | Yes | Channel ID for comcheck requests |
| `ANTHROPIC_API_KEY` | Yes | Claude API key (`sk-ant-...`) |
| `BROWSER_HEADLESS` | No | `true` for production, `false` for dev (default: `false`) |
| `BROWSER_DATA_DIR` | No | Browser profile path (default: `./browser-data`) |
| `COMCHECK_MAX_AMOUNT` | No | Max amount per comcheck (default: `500`) |
| `LUMPER_MAX_AMOUNT` | No | Max lumper amount without approval (default: `500`) |
| `REPAIR_MAX_AMOUNT` | No | Max repair amount without approval (default: `1500`) |
| `DAILY_TOTAL_LIMIT` | No | Daily total limit across all comchecks (default: `2500`) |
| `MOCK_BROWSER` | No | Skip real browser for testing (default: `false`) |
| `LOG_CHANNEL_ID` | No | Slack channel for system logs |
| `ADMIN_SLACK_USER_ID` | No | Admin's Slack user ID for 2FA alerts |
| `APPROVAL_USER_ID` | No | Manager's Slack user ID for approvals |
| `ADMIN_USER_IDS` | No | Comma-separated admin Slack user IDs |
| `REPORT_USER_IDS` | No | Comma-separated Slack user IDs for daily report |

## Initial 2FA Setup

The first time you run against Comdata, you'll need to complete 2FA manually:

1. Set `BROWSER_HEADLESS=false` in `.env`
2. Run `npm run dev`
3. The browser will open and navigate to Comdata login
4. When the 2FA prompt appears, Nikola will message you in Slack asking for the code
5. Reply with the SMS code in the Slack thread
6. After successful login, cookies are saved to `browser-data/` — future logins skip 2FA

If you need to redo 2FA, delete `browser-data/` and restart.

## Docker Deployment

```bash
# Build and deploy
./scripts/deploy.sh

# Or manually:
docker compose build
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

The Docker setup runs in headless mode with volumes for persistent data (`browser-data/`, `data/`, `screenshots/`, `logs/`).

**Important:** Complete the initial 2FA setup locally (headed mode) before deploying to Docker. Copy the `browser-data/` directory to the server so the container has valid session cookies.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in dev mode (headed browser, ts-node) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Production mode (`node dist/`) |
| `npx tsc --noEmit` | Type check without building |
| `npm run test:login` | Test login flow only |
| `npm run test:comcheck` | Test comcheck creation |
| `npm run test:e2e` | Full end-to-end test |

## Updating Selectors

If Comdata changes their UI, selectors will break. All selectors are centralized in `src/browser/selectors.ts`.

To discover new selectors:
1. Run `npm run discover` to scan the login/navigation pages
2. Run `npm run discover:comcheck` to scan the comcheck form
3. Update `src/browser/selectors.ts` with the new selectors
4. Test with `npm run test:login` and `npm run test:comcheck`

## Troubleshooting

**Bot not responding in Slack:**
- Check Socket Mode is enabled in your Slack app settings
- Verify `SLACK_APP_TOKEN` starts with `xapp-`
- Check logs: `docker compose logs -f` or `logs/` directory

**Login failing:**
- Delete `browser-data/` and redo 2FA setup
- Check if Comdata changed their login page — run `npm run discover`
- Verify `COMDATA_URL`, `COMDATA_USERNAME`, `COMDATA_PASSWORD`

**Comcheck form not working:**
- Run `npm run discover:comcheck` to check for selector changes
- Check `screenshots/` for debug captures

**2FA not working:**
- Ensure `ADMIN_SLACK_USER_ID` is set correctly
- Check `LOG_CHANNEL_ID` points to a channel the bot is in
- Try manual 2FA: run headed (`BROWSER_HEADLESS=false`) and complete it in the browser
