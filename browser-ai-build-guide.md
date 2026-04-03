# Browser AI — Complete Build Guide & Claude Code Prompts

## Architecture Overview

Your system has **3 layers** that we'll build in phases:

```
┌─────────────────────────────────────────────────┐
│  SLACK CHANNEL (#comcheck-requests)              │
│  Dispatchers talk to "Alex" (the AI persona)     │
│       ↕ Slack Bolt SDK (Socket Mode)             │
├─────────────────────────────────────────────────┤
│  ORCHESTRATOR SERVICE (Node.js / Express)        │
│  - Claude API (opus) = "Alex" brain              │
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

### Why NOT Opus as a standalone agent?

You're right to question this. Here's a simpler architecture than having a "separate Opus agent." Instead, build a **single Node.js service** that:

1. **Listens to Slack** via the Slack Bolt SDK (free, no enterprise plan needed)
2. **Uses the Claude API** to power the persona's conversational brain
3. **Calls Playwright functions directly** when the AI decides a comcheck is approved

This eliminates the need for two separate apps talking to each other. One codebase, one deployment. The Claude API call IS your "Opus agent" — it just lives inside your service.

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Node.js 20+ / TypeScript | Best Playwright + Slack SDK support |
| Browser automation | Playwright (programmatic API) | Persistent context for cookies/2FA |
| AI brain | Anthropic Claude API (Sonnet for speed, Opus for complex reasoning) | Powers the Slack persona |
| Slack integration | @slack/bolt (Socket Mode) | No public URL needed, works behind firewalls |
| State management | SQLite (via better-sqlite3) | Lightweight, no external DB needed |
| Config | dotenv + .env file | Secrets management |

---

# PHASE 1 — Browser Automation Foundation

> **Goal:** Reliably log into comdata.com, navigate the form, create a comcheck, and extract the result. Headed browser. Persistent cookies so 2FA only happens once.

---

## Prompt 1.1 — Project Scaffolding

```
I'm building a Node.js/TypeScript project called "browser-ai" that automates creating comchecks on comdata.com using Playwright.

Set up the project structure:

browser-ai/
├── src/
│   ├── browser/
│   │   ├── comdata-automation.ts    # Main automation logic
│   │   ├── browser-manager.ts       # Manages persistent browser context
│   │   └── selectors.ts             # All CSS/XPath selectors in one place
│   ├── config/
│   │   └── index.ts                 # Environment config loader
│   ├── types/
│   │   └── index.ts                 # TypeScript interfaces
│   └── index.ts                     # Entry point for testing automation standalone
├── browser-data/                    # Persistent browser profile (gitignored)
├── screenshots/                     # Debug screenshots (gitignored)
├── .env.example                     # Template for environment variables
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md

Requirements:
- TypeScript with strict mode
- Playwright as a dependency (not @playwright/test — we need the library, not the test runner)
- dotenv for config
- Scripts: "dev" (ts-node), "build" (tsc), "start" (node dist/)
- The .env.example should have: COMDATA_USERNAME, COMDATA_PASSWORD, COMDATA_URL (default https://www.comdata.com), BROWSER_HEADLESS (default false), BROWSER_DATA_DIR (default ./browser-data)
- The config/index.ts should validate all required env vars exist at startup and throw clear errors if missing
- The types should include: ComCheckRequest { payeeName, amount, expressCode?, memo? } and ComCheckResult { expressCode, confirmationNumber, createdAt }

Don't implement the automation logic yet — just the scaffolding, config, and types. Make sure it compiles and runs cleanly.
```

---

## Prompt 1.2 — Persistent Browser Manager

```
Now build src/browser/browser-manager.ts for managing a persistent Chromium browser context with Playwright.

Key requirements:

1. Use `chromium.launchPersistentContext()` — this is critical. It saves cookies, localStorage, and session data to a directory on disk. This means after I do 2FA once, the site remembers this browser and won't ask again.

2. The BrowserManager class should:
   - Accept config: { headless: boolean, userDataDir: string, slowMo?: number }
   - Have an `initialize()` method that launches the persistent context
   - Have a `getPage()` method that returns the active page (or creates one)
   - Have a `screenshot(name: string)` method that saves to ./screenshots/ with timestamp
   - Have a `close()` method that gracefully closes the context
   - Handle the case where the browser crashes — implement a `restart()` method
   - Set a realistic user agent string (Chrome 120+ on Windows)
   - Set viewport to 1920x1080
   - Use `--disable-blink-features=AutomationControlled` to avoid bot detection
   - Accept `slowMo: 100` in dev mode so I can watch what's happening

3. Add error handling: if the persistent context directory is locked (another instance running), throw a clear error.

4. Export a singleton instance that can be imported anywhere.

Important: Do NOT use browser.newContext() — that creates an ephemeral context and loses cookies. The entire point is launchPersistentContext().
```

---

## Prompt 1.3 — Comdata Login Automation

```
Now build the login flow in src/browser/comdata-automation.ts.

Create a ComdataAutomation class that uses BrowserManager and implements:

1. `login()` method:
   - Navigate to the Comdata login page
   - Wait for the page to fully load (networkidle)
   - Check if we're already logged in (look for a dashboard element or session indicator). If yes, skip login.
   - If not logged in:
     - Find the username field, clear it, type the username with a slight delay between keystrokes (humanlike)
     - Find the password field, clear it, type the password
     - Click the login/submit button
     - Wait for navigation to complete
   - After login, check for 2FA/MFA prompt:
     - If a 2FA screen appears, take a screenshot, log a message saying "2FA required — please complete manually in the browser window within 120 seconds", and poll every 2 seconds for up to 120 seconds waiting for the 2FA screen to disappear
     - Once 2FA is complete (or wasn't needed), verify we're on the dashboard
   - Take a screenshot at each major step for debugging
   - Return { success: boolean, message: string }

2. Put all selectors in src/browser/selectors.ts as named constants. Use data-testid or aria selectors where possible, fall back to CSS. Add comments noting these will need to be updated after first real login attempt since we don't know the exact DOM yet.

3. Add a `isLoggedIn()` helper method that checks current session state.

4. Add retry logic: if login fails, wait 5 seconds and retry up to 2 times.

5. Important: Between steps, add small random delays (500-1500ms) to appear human. Use a helper function `humanDelay()` for this.

For now, use PLACEHOLDER selectors clearly marked with "// TODO: Update after first manual inspection" — we'll update them after seeing the real page. Structure the code so selectors are easy to swap.

Also create a standalone test script at src/test-login.ts that:
- Loads config
- Initializes BrowserManager in headed mode
- Calls login()
- Takes a final screenshot
- Keeps the browser open for 30 seconds so I can inspect
- Closes cleanly
```

---

## Prompt 1.4 — Selector Discovery (Manual Step)

```
I've run the login test and can see the Comdata website in the headed browser. I need help building a selector discovery utility.

Create src/browser/discover-selectors.ts that:

1. Opens the browser to the Comdata login page
2. Uses page.evaluate() to scan the page and output:
   - All <input> elements with their: id, name, type, placeholder, aria-label, data-testid
   - All <button> and <a> elements that look like submit buttons
   - All <form> elements and their action URLs
3. Saves this information to a JSON file: ./discovery/login-page-selectors.json
4. Takes a full-page screenshot: ./discovery/login-page.png
5. Then waits for me to manually log in (polls for URL change or dashboard element)
6. After I'm logged in, runs the same scan on the dashboard/main page
7. Saves: ./discovery/dashboard-selectors.json and ./discovery/dashboard.png
8. Then navigates to whatever page has the "create comcheck" or "express code" form
9. Scans that form page too: ./discovery/comcheck-form-selectors.json and ./discovery/comcheck-form.png
10. Keeps the browser open for manual exploration

This is a one-time utility to map out the site's DOM structure so we can build reliable selectors.
```

---

## Prompt 1.5 — Comcheck Creation Flow

```
Based on the selectors I've discovered, now build the comcheck creation flow.

Add to ComdataAutomation class:

1. `navigateToComCheckForm()` method:
   - From the dashboard, navigate to the comcheck / express code creation page
   - Wait for the form to be visible
   - Return success/failure

2. `createComCheck(request: ComCheckRequest)` method:
   - Call navigateToComCheckForm() if not already on the form page
   - Fill in the form fields:
     - Payee name
     - Amount (handle dollar formatting — if the field expects "100.00" format, ensure it)
     - Memo/description if the field exists
     - Any other required fields (we'll discover these)
   - Take a screenshot of the filled form BEFORE submitting (for audit trail)
   - Click submit
   - Wait for the confirmation/result page
   - Extract the express code / comcheck number from the result page
   - Take a screenshot of the confirmation page
   - Return ComCheckResult { expressCode, confirmationNumber, createdAt }

3. `extractComCheckResult()` private method:
   - Parse the confirmation page to find the express code
   - Look for common patterns: a highlighted number, a "your code is:" pattern, a copyable field
   - If it can't find the code, take a screenshot and throw a descriptive error

4. Error handling throughout:
   - If any form field is not found, screenshot + throw
   - If submission fails (error message on page), capture the error text + screenshot
   - If the session expires mid-flow, detect it and re-login automatically

5. Add a comprehensive test at src/test-create-comcheck.ts that:
   - Logs in
   - Creates a test comcheck (use a safe small amount if in production, or flag this as a test)
   - Prints the result
   - Saves screenshots

Important: The selectors will be placeholders initially. Structure the code so I can easily update selectors.ts after seeing the real form. Each selector should have a descriptive name like COMCHECK_FORM.PAYEE_NAME_INPUT, COMCHECK_FORM.AMOUNT_INPUT, etc.
```

---

## Prompt 1.6 — Robust Session & Error Handling

```
Harden the browser automation with production-grade error handling.

1. Create src/browser/session-guard.ts — a wrapper that:
   - Before any automation action, checks if the session is still valid
   - Detects common "session expired" indicators (redirect to login, specific error messages)
   - Automatically re-authenticates if session is expired
   - Implements a mutex/lock so only one automation can run at a time (prevents concurrent form submissions)
   - Logs all actions with timestamps for debugging

2. Create src/browser/page-helpers.ts with utility functions:
   - `waitAndClick(page, selector, options?)` — waits for element, scrolls into view, clicks
   - `waitAndFill(page, selector, value, options?)` — waits, clears existing value, types with human-like delay
   - `waitForNavigation(page, urlPattern?)` — waits for page navigation with timeout
   - `getTextContent(page, selector)` — safely extracts text, returns null if not found
   - `screenshotWithContext(page, name)` — takes screenshot with timestamp, URL, and page title in filename
   - `detectErrors(page)` — scans for common error messages, modal dialogs, alerts

3. Add to BrowserManager:
   - Connection health check (is the browser still responsive?)
   - Automatic recovery if the browser process dies
   - Cookie export/import as backup (save cookies to JSON periodically)

4. Create a test at src/test-session-recovery.ts that:
   - Logs in
   - Manually clears cookies via page.context().clearCookies()
   - Attempts to create a comcheck
   - Verifies it automatically re-authenticates and succeeds
```

---

# PHASE 2 — Slack AI Agent ("Alex")

> **Goal:** Create a Slack bot persona that lives in a channel, converses with dispatchers naturally, collects comcheck request details, validates them, and triggers the browser automation.

---

## Prompt 2.1 — Slack Bot Setup

```
Add Slack integration to the browser-ai project.

Install @slack/bolt and add:

src/
├── slack/
│   ├── app.ts              # Slack Bolt app initialization
│   ├── handlers/
│   │   ├── message.ts       # Handles incoming messages
│   │   ├── commands.ts      # Slash commands (optional)
│   │   └── events.ts        # App mention, reaction events
│   ├── middleware/
│   │   └── auth.ts          # Channel/user authorization
│   └── utils/
│       └── formatting.ts    # Slack Block Kit message formatting

Requirements:

1. Use Socket Mode (not HTTP) — this means:
   - We need SLACK_BOT_TOKEN and SLACK_APP_TOKEN (xapp- token for socket mode)
   - No public URL or ngrok needed
   - Works behind any firewall
   - Add SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET to .env.example

2. The bot should:
   - Only respond in a specific channel (SLACK_CHANNEL_ID in .env)
   - Respond when @mentioned or when a direct message is sent
   - Always respond in a thread (keeps the channel clean)
   - Show a typing indicator while processing

3. For now, just set up the Slack connection and a simple echo handler that responds to any message with "I received: [their message]". We'll add the AI brain next.

4. Update the main entry point (src/index.ts) to:
   - Start the Slack bot
   - Initialize the BrowserManager
   - Gracefully shut down both on SIGINT/SIGTERM

5. Add a health check: every 60 seconds, log that the bot is alive and the browser is responsive.

Also provide step-by-step instructions (as comments in the code) for:
- Creating the Slack app at api.slack.com
- Required OAuth scopes: chat:write, app_mentions:read, channels:history, channels:read, groups:history, im:history, im:read, im:write
- Enabling Socket Mode
- Subscribing to events: message.channels, message.im, app_mention
- Getting the tokens
```

---

## Prompt 2.2 — AI Conversation Engine (The "Alex" Brain)

```
Build the AI conversation engine that powers the Slack persona "Alex."

Create:

src/
├── ai/
│   ├── agent.ts             # Main AI agent using Claude API
│   ├── system-prompt.ts     # Alex's personality and instructions
│   ├── conversation.ts      # Conversation history management
│   └── tools.ts             # Function definitions for the AI (create_comcheck, etc.)

Requirements:

1. agent.ts — AgentBrain class:
   - Uses the Anthropic SDK (@anthropic-ai/sdk)
   - Takes a message + conversation history, returns a response
   - Supports tool use (function calling) for when the AI decides to create a comcheck
   - Add ANTHROPIC_API_KEY to .env.example
   - Use claude-sonnet-4-20250514 for speed (this runs on every message)

2. system-prompt.ts — Define Alex's persona:
   ```
   You are Alex, a friendly and professional team member at [Company Name] who works in the finance/payments department. You help dispatchers get comchecks (express codes) created through Comdata.

   Your personality:
   - Professional but warm and approachable
   - You use casual workplace language (not too formal)
   - You're helpful and patient with requests
   - You respond like a real coworker, not a robot
   - You use natural punctuation, occasionally emojis (sparingly)
   - You remember context from the current conversation thread

   Your process for comcheck requests:
   1. When someone requests a comcheck, you need to collect:
      - Payee name (who the check is for)
      - Amount (dollar amount)
      - Reason/memo (what it's for — e.g., "lumper fee", "fuel advance", etc.)
      - Any load number or reference number
   2. Once you have all details, confirm them back to the dispatcher
   3. Wait for their confirmation before creating the check
   4. Create the check (you'll call the create_comcheck tool)
   5. Share the express code back to them

   Rules:
   - Maximum single comcheck amount: $[CONFIGURABLE — set via env var]
   - Always confirm details before creating
   - If a request seems unusual (very high amount, vague reason), ask follow-up questions
   - Never share that you're an AI. You're Alex, a team member.
   - If asked personal questions, deflect casually ("Ha, you know me — always here working!")
   - Outside of comcheck requests, you can have brief casual conversation but gently redirect to work
   ```

3. conversation.ts — ConversationManager:
   - Stores conversation history per Slack thread (thread_ts is the key)
   - Keeps last 20 messages per thread (sliding window)
   - Stores in SQLite so conversations survive restarts
   - Has a TTL: conversations older than 24 hours are cleared
   - Methods: addMessage(threadId, role, content), getHistory(threadId), clearThread(threadId)

4. tools.ts — Define the tool the AI can call:
   ```typescript
   const tools = [{
     name: "create_comcheck",
     description: "Create a comcheck / express code in Comdata for a dispatcher",
     input_schema: {
       type: "object",
       properties: {
         payee_name: { type: "string", description: "Name of the person/company receiving the check" },
         amount: { type: "number", description: "Dollar amount of the comcheck" },
         memo: { type: "string", description: "Reason for the comcheck (e.g., lumper fee, fuel advance)" },
         reference_number: { type: "string", description: "Load number or reference, if provided" }
       },
       required: ["payee_name", "amount", "memo"]
     }
   }]
   ```

5. When the AI calls create_comcheck, don't execute it yet — just log it. We'll wire it up in Phase 3.

6. Add COMCHECK_MAX_AMOUNT to .env (default 500) for the validation rule.
```

---

## Prompt 2.3 — Wire Slack to AI Brain

```
Connect the Slack message handler to the AI agent so "Alex" can have real conversations.

Update src/slack/handlers/message.ts:

1. When a message comes in (mention or DM):
   - Ignore bot messages (prevent loops)
   - Ignore messages outside the designated channel
   - Get or create conversation history for this thread
   - Add the user's message to history
   - Send the history + new message to AgentBrain
   - If the AI responds with text, post it to the Slack thread
   - If the AI calls the create_comcheck tool, log it and post a "working on it..." message (we'll actually execute it in Phase 3)
   - Add the AI's response to conversation history
   - Handle errors gracefully — post a friendly error message if something breaks

2. Add typing indicator:
   - When processing starts, show the typing indicator
   - Respond within the thread (use thread_ts)

3. Add user context:
   - When calling the AI, include the Slack user's display name so Alex can address them by name
   - Format: "Message from [Display Name]: [their message]"

4. Rate limiting:
   - Max 5 requests per user per minute
   - If exceeded, respond: "Hey, give me a sec to catch up! I'll be right with you."

5. Error messages should be in-character:
   - Generic error: "Hmm, something went sideways on my end. Give me a minute and try again?"
   - Browser down: "I'm having some trouble with our system right now. Let me figure this out — try again in a few minutes."

Create a test at src/test-slack-ai.ts that:
- Starts the Slack bot with the AI brain
- Logs all incoming/outgoing messages to console
- Runs in headed browser mode so I can watch everything
```

---

## Prompt 2.4 — Conversation State Machine

```
The AI handles the conversation naturally, but we need a structured state machine to track where each comcheck request is in the process. This prevents duplicates and provides auditability.

Create src/state/request-tracker.ts:

1. RequestTracker class with SQLite backing:
   - Table: comcheck_requests
     - id (UUID)
     - slack_thread_ts (string)
     - slack_user_id (string)
     - slack_user_name (string)
     - status: 'gathering_info' | 'pending_confirmation' | 'confirmed' | 'processing' | 'completed' | 'failed' | 'cancelled'
     - payee_name (string, nullable)
     - amount (number, nullable)
     - memo (string, nullable)
     - reference_number (string, nullable)
     - express_code (string, nullable — filled after creation)
     - confirmation_number (string, nullable)
     - created_at (datetime)
     - updated_at (datetime)
     - completed_at (datetime, nullable)
     - error_message (string, nullable)

2. Methods:
   - createRequest(threadTs, userId, userName): creates with 'gathering_info' status
   - updateRequest(id, updates): partial update
   - getActiveRequest(threadTs): gets the in-progress request for a thread (not completed/failed)
   - completeRequest(id, expressCode, confirmationNumber): marks done
   - failRequest(id, error): marks failed
   - getRequestsByUser(userId, limit): recent history
   - getRequestStats(): daily/weekly counts for monitoring

3. When the AI calls create_comcheck tool:
   - Check if there's already an active request in this thread
   - If processing/completed, tell the AI "there's already a pending request in this thread"
   - Update the request status to 'confirmed' → 'processing'
   - After browser automation, update to 'completed' or 'failed'

4. Add a cleanup job that runs every hour:
   - Requests stuck in 'processing' for more than 10 minutes → mark as 'failed'
   - Requests in 'gathering_info' for more than 24 hours → mark as 'cancelled'
```

---

# PHASE 3 — Wire It All Together

> **Goal:** Connect the AI agent to the browser automation so approved comcheck requests actually get created.

---

## Prompt 3.1 — Orchestrator Service

```
Build the orchestrator that connects the AI tool calls to the browser automation.

Create src/orchestrator/index.ts:

1. ComCheckOrchestrator class:
   - Accepts a tool call from the AI agent
   - Validates the request (amount within limits, required fields present)
   - Acquires the browser automation lock (only one at a time)
   - Calls ComdataAutomation.login() if needed
   - Calls ComdataAutomation.createComCheck(request)
   - Returns the result (express code) or error
   - Updates the RequestTracker with the result
   - Releases the lock

2. Queue system (simple, in-process):
   - If a comcheck is already being created, queue the next one
   - Process queue sequentially (browser can only do one thing at a time)
   - Queue has a max size of 10 — reject beyond that
   - Each queued item has a timeout of 5 minutes

3. Update the Slack message handler (from Prompt 2.3):
   - When AI calls create_comcheck:
     1. Post to Slack: "Got it! Creating that comcheck now... give me a moment ⏳"
     2. Submit to orchestrator queue
     3. When complete, post to Slack: "All set! Here's the express code: **[CODE]** (Confirmation: [NUMBER]). Let me know if you need anything else!"
     4. If it fails, post: "I ran into an issue creating that check. [Error details]. Want me to try again?"

4. Implement retry logic in the orchestrator:
   - If browser automation fails with a session error, retry once after re-login
   - If it fails with a form error, don't retry — report the error
   - Max 2 attempts total

5. Update src/index.ts to wire everything together:
   - Initialize BrowserManager
   - Initialize ComdataAutomation
   - Initialize RequestTracker (SQLite)
   - Initialize ComCheckOrchestrator
   - Initialize AgentBrain
   - Initialize Slack bot with all dependencies injected
   - Graceful shutdown sequence: stop accepting Slack messages → drain queue → close browser → exit
```

---

## Prompt 3.2 — End-to-End Testing Harness

```
Create a comprehensive testing setup that validates the full flow without needing real Slack.

Create src/test/e2e-test.ts:

1. MockSlackMessage class that simulates a dispatcher conversation:
   - Sends messages to the AI agent directly (bypassing Slack)
   - Prints the AI's responses to console
   - Simulates a full conversation:
     a. "Hey Alex, I need a comcheck"
     b. AI asks for details
     c. "It's for John Smith, $150, lumper fee at warehouse, load #12345"
     d. AI confirms details
     e. "Yes that's correct"
     f. AI triggers create_comcheck tool
     g. Orchestrator runs browser automation
     h. Express code is returned

2. Create mock mode for browser automation:
   - Flag: MOCK_BROWSER=true in .env
   - When true, ComdataAutomation.createComCheck() returns a fake result after a 3-second delay
   - This allows testing the AI conversation + orchestrator without hitting the real website

3. Create an integration test that runs the REAL browser:
   - Requires MOCK_BROWSER=false
   - Runs the full flow end-to-end
   - Saves screenshots at every step
   - Logs the complete timeline with durations

4. Add a test for error scenarios:
   - Amount exceeds max → AI should reject
   - Browser is unavailable → graceful error message
   - Concurrent requests → proper queuing
   - Session expires mid-creation → auto-recovery

Print a clear PASS/FAIL summary at the end.
```

---

## Prompt 3.3 — Monitoring & Logging

```
Add production-grade logging and monitoring.

1. Create src/utils/logger.ts:
   - Use winston or pino for structured logging
   - Log levels: error, warn, info, debug
   - Log to console (colorized in dev) AND to a daily rotating file
   - Include context: timestamp, component (browser/slack/ai/orchestrator), requestId
   - Sensitive data: NEVER log passwords, but DO log usernames and actions

2. Create src/monitoring/health.ts:
   - Health check function that returns:
     - Slack connection: connected/disconnected
     - Browser: alive/dead/restarting
     - Last successful comcheck: timestamp
     - Queue depth: number
     - Uptime: duration
   - Post a daily summary to a #browser-ai-logs Slack channel (separate from the dispatcher channel):
     - Total comchecks created today
     - Success/failure count
     - Average creation time
     - Any errors

3. Add a Slack slash command /comcheck-status that (only for admin users):
   - Shows current system health
   - Shows pending queue
   - Shows today's request count

4. Error alerting:
   - If browser automation fails 3 times in a row, post an alert to #browser-ai-logs
   - If the bot has been unresponsive for 5 minutes, post an alert
   - Include @channel mention on critical alerts

5. Add audit logging to RequestTracker:
   - Log every state transition with timestamp
   - Store in a separate audit_log table
   - Fields: request_id, old_status, new_status, triggered_by, timestamp, details
```

---

# PHASE 4 — Hardening & Production

> **Goal:** Make it reliable enough to run 24/7 unattended.

---

## Prompt 4.1 — 2FA Handling Strategy

```
Implement a robust 2FA handling strategy for Comdata.

Since we're using a persistent browser profile, 2FA should only be needed:
- First time ever
- If cookies expire (rare, usually 30-90 days)
- If Comdata's security flags something unusual

Create src/browser/two-factor-handler.ts:

1. TwoFactorHandler class:
   - Detect when 2FA is prompted (check for specific page elements)
   - THREE strategies, tried in order:

   Strategy A: Cookie Persistence (primary)
   - The persistent browser profile should handle this automatically
   - After manual 2FA completion, cookies are saved to the profile directory
   - Next login should skip 2FA entirely

   Strategy B: Manual Completion with Slack Alert
   - If 2FA is detected, post to #browser-ai-logs: "⚠️ 2FA required for Comdata login. Please complete it within 5 minutes. @admin"
   - Keep the browser headed and wait for manual completion
   - Poll every 3 seconds for up to 5 minutes
   - Once completed, continue the flow
   - This is the fallback for when cookies expire

   Strategy C: TOTP Auto-Entry (advanced, implement later)
   - If using an authenticator app, store the TOTP secret
   - Generate the code programmatically using otplib
   - Auto-fill the 2FA field
   - Only implement if Comdata uses standard TOTP (not SMS)
   - Add COMDATA_TOTP_SECRET to .env

2. After any successful 2FA:
   - Export cookies to a backup JSON file
   - Log the event for monitoring

3. Add to the login flow:
   - Before login, restore cookies from backup if the profile directory seems empty
   - After login, verify the session is valid
```

---

## Prompt 4.2 — Process Manager & Auto-Recovery

```
Make the service resilient for 24/7 operation.

1. Create src/process/manager.ts:
   - Watchdog timer: if no activity for 30 minutes, verify all systems are responsive
   - Browser heartbeat: every 5 minutes, check if the browser is still alive
   - If browser dies, restart it automatically
   - If restart fails 3 times, alert and enter degraded mode (Slack still works, browser commands queue up)

2. Create ecosystem.config.js for PM2:
   - Run with pm2 for auto-restart on crash
   - Max memory: 1GB (restart if exceeded)
   - Max restarts: 10 in 15 minutes (prevent crash loops)
   - Log rotation: keep 7 days

3. Create a startup script (scripts/start.sh):
   - Check Node.js version (18+)
   - Check Playwright browsers are installed
   - Check .env exists and has required vars
   - Start with pm2
   - Verify the bot comes online (health check)

4. Create scripts/backup-cookies.sh:
   - Copies the browser-data/ directory to a backup location
   - Runs daily via cron
   - Keeps last 7 backups

5. Handle graceful shutdown:
   - On SIGTERM: finish current comcheck if in progress, then shut down
   - Save browser state before exit
   - Post to #browser-ai-logs: "Browser AI going offline for maintenance"
   - On startup, post: "Browser AI is back online! 🟢"
```

---

## Prompt 4.3 — Security & Access Control

```
Add security measures to the system.

1. Create src/security/access-control.ts:
   - Whitelist of Slack user IDs who can request comchecks (ALLOWED_USER_IDS in .env, comma-separated)
   - Admin user IDs who can use /comcheck-status (ADMIN_USER_IDS in .env)
   - If an unauthorized user tries to request, Alex responds: "Hey! I don't think we've met. You'll need to talk to [manager name] to get set up for comcheck requests."
   - Log unauthorized attempts

2. Request validation:
   - Amount must be positive and within max limit
   - Payee name must not be empty and must be reasonable length (3-100 chars)
   - Rate limit: max 20 comchecks per user per day
   - Daily total limit: max $X,XXX across all users (DAILY_TOTAL_LIMIT in .env)
   - If daily limit is approaching, Alex warns: "Heads up, we're getting close to our daily limit."

3. Sensitive data:
   - .env is in .gitignore
   - Comdata password is never logged
   - Express codes are logged but only in the audit log
   - Screenshots may contain sensitive data — ensure screenshots/ is gitignored and auto-cleaned after 7 days

4. Add an IP binding option:
   - If Comdata is IP-restricted, document how to set up a static IP (or VPN)
   - Add proxy support to BrowserManager (BROWSER_PROXY in .env)
```

---

# PHASE 5 — Polish & Deploy

---

## Prompt 5.1 — Alex Personality Refinement

```
Refine Alex's conversation abilities for realistic workplace interaction.

Update the system prompt and add conversation scenarios:

1. Enhance system-prompt.ts with:
   - Handling small talk: "How's it going?" → brief, friendly response then redirect
   - Handling multiple requests in one message: "I need two comchecks — one for $100 for John and one for $200 for Jane" → handle sequentially
   - Handling corrections: "Wait, I said $100 but I meant $150" → gracefully update
   - Handling cancellations: "Never mind, cancel that" → cancel and confirm
   - Handling status checks: "Did you create that check yet?" → check RequestTracker
   - Handling ambiguity: "Same as last time" → check recent history for the user
   - Time awareness: greet differently based on time of day (good morning/afternoon)
   - Weekend/holiday awareness: "I'm here but just a heads up, some things might take longer outside business hours"

2. Create src/ai/few-shot-examples.ts:
   - 5-6 example conversation flows that are included in the system prompt
   - Cover: happy path, missing details, correction, rejection (over limit), casual chat redirect
   - These help the AI maintain consistent personality

3. Add conversation memory enrichment:
   - When a user has used the system before, Alex can reference past interactions naturally
   - "Hey Mike, another lumper fee? Same payee as last week or different?"
   - Query RequestTracker for user's recent requests

4. Response formatting for Slack:
   - Use Slack Block Kit for structured messages when sharing express codes
   - Express code should be in a code block for easy copying
   - Include amount and payee in the confirmation for clarity
   - Add a ✅ reaction to the user's message when the check is created
```

---

## Prompt 5.2 — Docker Deployment

```
Containerize the application for deployment.

Create:

1. Dockerfile:
   - Base: node:20-slim
   - Install Playwright Chromium dependencies
   - Install Playwright browsers
   - Copy project, install deps, build TypeScript
   - Run as non-root user
   - Expose no ports (Socket Mode needs no inbound connections)
   - Volume mount for: browser-data/, screenshots/, logs/, data/ (SQLite)

2. docker-compose.yml:
   - Single service: browser-ai
   - Environment variables from .env
   - Volume mounts for persistent data
   - Restart policy: unless-stopped
   - Resource limits: 2GB RAM, 2 CPU
   - Health check: curl-based or custom script

3. .dockerignore:
   - node_modules, dist, .env, browser-data, screenshots, *.log

4. scripts/deploy.sh:
   - Build the Docker image
   - Stop the old container
   - Start the new container
   - Verify health
   - Rollback if health check fails

5. Add to README.md:
   - Complete setup guide
   - Environment variable documentation
   - How to do the initial 2FA setup (run in headed mode first)
   - Troubleshooting common issues
   - How to update selectors if Comdata changes their UI
```

---

# Appendix: Slack App Setup Checklist

Create your Slack app at https://api.slack.com/apps:

1. **Create New App** → From scratch → Name it whatever "Alex" should be called
2. **OAuth & Permissions** → Bot Token Scopes:
   - `chat:write` (send messages)
   - `app_mentions:read` (hear @mentions)
   - `channels:history` (read channel messages)
   - `channels:read` (list channels)
   - `groups:history` (private channel messages)
   - `im:history` (DM history)
   - `im:read` (DM access)
   - `im:write` (send DMs)
   - `reactions:write` (add emoji reactions)
   - `users:read` (get user display names)
3. **Socket Mode** → Enable → Generate app-level token (xapp-)
4. **Event Subscriptions** → Enable → Subscribe to:
   - `message.channels`
   - `message.im`
   - `app_mention`
5. **App Home** → Show bot as online
6. **Install to Workspace** → Copy Bot User OAuth Token (xoxb-)
7. **Set the bot's display name and avatar** to match the "Alex" persona

---

# Build Order Summary

| Phase | Prompt | What You'll Have Working |
|-------|--------|--------------------------|
| 1 | 1.1 | Project structure, TypeScript compiles |
| 1 | 1.2 | Browser launches with persistent cookies |
| 1 | 1.3 | Login automation (with 2FA pause) |
| 1 | 1.4 | Selector map of Comdata's UI |
| 1 | 1.5 | Full comcheck creation flow |
| 1 | 1.6 | Error recovery, session management |
| 2 | 2.1 | Slack bot connected and echoing |
| 2 | 2.2 | AI "Alex" persona with Claude API |
| 2 | 2.3 | Alex converses in Slack threads |
| 2 | 2.4 | Request tracking with SQLite |
| 3 | 3.1 | Slack → AI → Browser → Slack flow complete |
| 3 | 3.2 | Full test harness with mock mode |
| 3 | 3.3 | Logging, monitoring, alerts |
| 4 | 4.1 | 2FA auto-handling |
| 4 | 4.2 | 24/7 reliability with PM2 |
| 4 | 4.3 | Access control, rate limits, security |
| 5 | 5.1 | Polished AI personality |
| 5 | 5.2 | Docker deployment |

**Estimated build time:** 3-5 days for an experienced developer using Claude Code, or 1-2 weeks working through it methodically.
