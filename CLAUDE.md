# Browser AI — Project Context for Claude Code

## What This Project Does
Automates comcheck creation on comdata.com and exposes it through a Slack bot persona named "Alex" powered by Claude API.

## Architecture
- Single Node.js/TypeScript service
- Playwright with persistent browser context for web automation
- Slack Bolt SDK (Socket Mode) for Slack integration
- Anthropic Claude API for AI conversation
- SQLite for state management

```
┌─────────────────────────────────────────────────┐
│  SLACK CHANNEL (#comcheck-requests)              │
│  Dispatchers talk to "Alex" (the AI persona)     │
│       ↕ Slack Bolt SDK (Socket Mode)             │
├─────────────────────────────────────────────────┤
│  ORCHESTRATOR SERVICE (Node.js / Express)        │
│  - Claude API (Sonnet) = "Alex" brain            │
│  - Approval logic / validation rules             │
│  - Request queue + state machine                 │
│       ↕ Internal function calls                  │
├─────────────────────────────────────────────────┤
│  BROWSER AUTOMATION (Playwright)                 │
│  - Persistent browser profile (cookies/2FA)      │
│  - Login → Fill form → Extract comcheck         │
│  - Headed mode (dev) → Headless (prod)           │
└─────────────────────────────────────────────────┘
```

## Key Constraints
- Browser MUST use `chromium.launchPersistentContext()` (not `browser.newContext()`) for cookie/2FA persistence
- Only one browser automation can run at a time (mutex lock)
- All Slack responses must be in threads (use thread_ts)
- Alex persona must never reveal it's an AI
- Comcheck amounts have a configurable max limit (COMCHECK_MAX_AMOUNT in .env)
- Selectors are centralized in `src/browser/selectors.ts` — never hardcode selectors elsewhere

## Project Structure
```
browser-ai/
├── src/
│   ├── browser/
│   │   ├── browser-manager.ts       # Persistent Chromium context manager
│   │   ├── comdata-automation.ts     # Login + comcheck creation logic
│   │   ├── selectors.ts             # ALL CSS/XPath selectors (single source of truth)
│   │   ├── session-guard.ts         # Session validity checks + auto re-auth
│   │   ├── page-helpers.ts          # waitAndClick, waitAndFill, humanDelay, etc.
│   │   └── two-factor-handler.ts    # 2FA detection and handling strategies
│   ├── slack/
│   │   ├── app.ts                   # Slack Bolt initialization (Socket Mode)
│   │   ├── handlers/
│   │   │   ├── message.ts           # Message event handler
│   │   │   ├── commands.ts          # Slash commands (/comcheck-status)
│   │   │   └── events.ts            # App mention, reactions
│   │   ├── middleware/
│   │   │   └── auth.ts              # Channel/user authorization
│   │   └── utils/
│   │       └── formatting.ts        # Slack Block Kit formatting
│   ├── ai/
│   │   ├── agent.ts                 # Claude API integration (Alex's brain)
│   │   ├── system-prompt.ts         # Alex's personality, rules, few-shot examples
│   │   ├── conversation.ts          # Per-thread conversation history (SQLite backed)
│   │   └── tools.ts                 # Tool definitions (create_comcheck)
│   ├── orchestrator/
│   │   └── index.ts                 # Connects AI tool calls → browser automation
│   ├── state/
│   │   └── request-tracker.ts       # SQLite request tracking + audit log
│   ├── security/
│   │   └── access-control.ts        # User whitelists, rate limits, amount limits
│   ├── monitoring/
│   │   └── health.ts                # Health checks, daily summaries, alerts
│   ├── config/
│   │   └── index.ts                 # Environment config loader + validation
│   ├── types/
│   │   └── index.ts                 # TypeScript interfaces
│   ├── utils/
│   │   └── logger.ts                # Structured logging (winston/pino)
│   └── index.ts                     # Main entry point
├── browser-data/                    # Persistent browser profile (GITIGNORED)
├── screenshots/                     # Debug screenshots (GITIGNORED)
├── data/                            # SQLite database (GITIGNORED)
├── logs/                            # Log files (GITIGNORED)
├── discovery/                       # Selector discovery output (temporary)
├── browser-ai-build-guide.md        # Full build guide with all prompts
├── CLAUDE.md                        # THIS FILE — project context for Claude Code
├── .env                             # Secrets (NEVER COMMIT)
├── .env.example                     # Template for .env
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Development Commands
- `npm run dev` — Start in development mode (headed browser, ts-node)
- `npm run build` — Compile TypeScript to dist/
- `npm start` — Production mode (node dist/)
- `npx tsc --noEmit` — Type check without building
- `npx ts-node src/test-login.ts` — Test login flow only
- `npx ts-node src/test-create-comcheck.ts` — Test comcheck creation
- `npx ts-node src/test-slack-ai.ts` — Test Slack + AI integration
- `npx ts-node src/test/e2e-test.ts` — Full end-to-end test

## Environment Variables (.env)
```
# Comdata
COMDATA_URL= refer to (.env)
COMDATA_USERNAME= refer to (.env)
COMDATA_PASSWORD= refer to (.env)
COMDATA_TOTP_SECRET=           # Optional: for auto 2FA

# Browser
BROWSER_HEADLESS=false         # true for production
BROWSER_DATA_DIR=./browser-data
BROWSER_SLOW_MO=100            # ms delay between actions (0 in prod)
BROWSER_PROXY=                 # Optional: http://proxy:port

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=C0XXXXXXX     # Channel where Nikola lives

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Limits
COMCHECK_MAX_AMOUNT=500
DAILY_TOTAL_LIMIT=2000
MOCK_BROWSER=false             # true to skip real browser in testing

# Access Control
ALLOWED_USER_IDS=U01,U02,U03   # Comma-separated Slack user IDs
ADMIN_USER_IDS=U01              # Who can use /comcheck-status

# Monitoring
LOG_CHANNEL_ID=C0XXXXXXX       # #browser-ai-logs channel
```

## Important Rules for Building This Project
1. **One prompt at a time.** The full build guide is in `browser-ai-build-guide.md`. Only implement what the current prompt asks for.
2. **Verify after every change.** Run `npx tsc --noEmit` and any relevant tests.
3. **Selectors are fragile.** Always put them in `src/browser/selectors.ts`, never inline. They WILL need updating when we see the real site.
4. **Persistent context is non-negotiable.** Never use `browser.newContext()` — always `chromium.launchPersistentContext()`. This preserves cookies and 2FA state.
5. **Thread-based conversations.** Every Slack response uses `thread_ts`. Never post to the main channel feed.
6. **Alex is a person.** The AI persona never says "I'm an AI" or "As an AI." It's a coworker named Alex.
7. **Sequential automation.** Only one comcheck can be created at a time. Use a mutex/queue.
8. **Screenshot everything.** During browser automation, take screenshots at every major step for debugging.

## Testing
- Set `MOCK_BROWSER=true` in `.env` to test AI + Slack without hitting comdata.com
- Run headed browser (`BROWSER_HEADLESS=false`) during development to watch automation
- Check `screenshots/` directory for debug captures after any automation run
- Check `data/` directory for SQLite database state

## Tech Stack
| Component | Package | Version |
|-----------|---------|---------|
| Runtime | Node.js | 20+ |
| Language | TypeScript | 5.x |
| Browser | playwright | latest |
| Slack | @slack/bolt | latest |
| AI | @anthropic-ai/sdk | latest |
| Database | better-sqlite3 | latest |
| Config | dotenv | latest |
| Logging | winston or pino | latest |
| Process mgmt | pm2 | latest (production) |
