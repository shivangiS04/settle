# Settle: AI escrow for freelance work, on PayPal

> Built for the PayPal **"Build What's Next with PayPal and AI"** hackathon. Runs fully on the **PayPal Sandbox**.


## Try it in 2 minutes

**Live demo: https://settle-wuro.onrender.com**. It's on Render's free tier, so the first load after idle can take about a minute.

To fund escrow you log in to PayPal with a **sandbox test account**. It uses fake money; nothing real is charged.

```
Sandbox buyer email:    <FILL_ME>
Sandbox buyer password: <FILL_ME>
```

1. Use the header switch **View as Client / View as Freelancer** to act as either party.
2. As the Client, go to **New from chat → Use sample thread → Extract contract with AI**.
3. Click **Accept terms**, switch to **Freelancer**, and click **Accept terms** again. The status becomes AGREED.
4. Switch to **Client** and click the PayPal button on milestone 1. Log in with the sandbox buyer above. The status becomes **FUNDED**: the money is held, not charged.
5. Switch to **Freelancer**, choose **Live URL**, and submit this known-good delivery: **https://settle-wuro.onrender.com/demo-delivery/**. The Verifier Agent checks it at desktop and 375px.
6. Switch to **Client** and click **Approve & release**. This captures the payment, takes the 3% fee and pays out to the freelancer.
7. Open the **Ops dashboard (/dashboard)** and click the contract to see the audit trail of every AI decision and PayPal call.

If the data looks used, click **↺ Reset demo** in the header. It resets the app data only and never touches PayPal.

![TODO: contract extracted from a chat thread](docs/screenshots/contract-from-chat.png)
![TODO: verifier results with desktop + 375px screenshots](docs/screenshots/verifier-results.png)
![TODO: ops dashboard with audit trail panel](docs/screenshots/ops-dashboard.png)

## The problem

Most freelance work isn't agreed on a marketplace. It's agreed in a WhatsApp thread, an email chain or a LinkedIn DM. Then:

- **Freelancers** deliver first and chase invoices for weeks, or don't get paid at all.
- **Clients** pay upfront and hope the work arrives as described.
- When something goes wrong, nobody can say *what was agreed*, so arguments are about recollection, not evidence.

Marketplaces solve this with escrow and dispute teams, and charge 10–20% for it. **Settle** gives two people who met anywhere the same protection for 3%. Settle turns the chat into a contract with testable acceptance criteria and holds the money with a PayPal authorization. An AI agent checks the delivery against the criteria and releases the money when the client approves. If the client disputes, an AI mediator proposes a split.

**Every AI decision and every PayPal call is written to an audit trail**, because AI that moves money has to be explainable.

---

## What it does

| Step | Who | What happens | PayPal API |
|---|---|---|---|
| 1. Paste thread | either party | **Contract Agent** extracts parties, milestones, amounts, due dates and 2–5 *testable* acceptance criteria per milestone. Both parties edit, then accept. | – |
| 2. Fund | client | PayPal Checkout button, **Orders v2 `intent=AUTHORIZE`**. Funds are *held*, not captured. `authorization_id` is stored. | Orders v2 create + authorize |
| 3. Deliver | freelancer | Submit a live URL, a GitHub repo, or text. | – |
| 4. Verify | AI | **Verifier Agent** loads URLs in headless Chromium at desktop and 375px, takes screenshots, and extracts DOM facts. A vision-capable LLM (Gemini 3.5 Flash live) then judges each criterion. GitHub: README, file tree and key files. Text: word count is computed in code. | – |
| 5a. Approve | client (or auto after N h at 100%) | Capture the authorization, then send a **Payout** to the freelancer minus the 3% fee. | Authorizations capture, Payouts |
| 5b. Dispute | client | **Mediator Agent** proposes a split with reasoning. Each party accepts or counters (max 2 rounds). On agreement: **partial capture with `final_capture=true`** (PayPal voids the rest back to the client), then payout. | Capture (partial), Payouts |
| 6. Webhooks | PayPal | Signature-verified, replay-deduped webhooks drive the state machine. | Webhooks verify-signature |
| 7. Ops | platform | AG Grid dashboard: contracts, then milestones, then per-criterion verifier results. Pinned totals; click any row for its **audit trail**. | – |
| 8. Assistant | either party | Chat agent: "what's pending for me?", "remind the client", "invoice the extra work". Uses the **PayPal Agent Toolkit**. Every action needs a **Confirm** click. | Invoicing, Transactions (via Agent Toolkit) |

Milestone state machine:

```
DRAFT → AGREED → FUNDED → SUBMITTED → VERIFIED → APPROVED ───────────────→ SETTLED
                                              ↘ DISPUTED → MEDIATED ──→ SETTLED
```

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js UI<br/>role switcher]
    BTN[PayPal JS SDK<br/>Buttons intent=authorize]
    GRID[AG Grid ops dashboard]
    CHAT[Assistant chat +<br/>Confirm cards]
  end

  subgraph Server["Next.js server (Render, Docker)"]
    API[Route handlers]
    SM[State machine<br/>lib/state.ts]
    ESC[Escrow service<br/>lib/escrow.ts]
    PP[lib/paypal/*<br/>typed wrappers<br/>PayPal-Request-Id]
    AG[Agents<br/>lib/agents/*<br/>prompts.ts]
    VER[Verifier tools<br/>Playwright + GitHub API]
    PA[ProposedAction<br/>human-in-the-loop]
    TICK[Tick: auto-approve,<br/>auth expiry, payout sync]
    AUD[(AuditEvent)]
  end

  DB[(Postgres<br/>Prisma)]
  PAYPAL[(PayPal Sandbox<br/>Orders · Payments · Payouts<br/>Invoicing · Webhooks)]
  LLM[(LLM provider<br/>Gemini 3.5 Flash live / Claude optional)]

  UI --> API
  BTN -->|createOrder / onApprove| API
  GRID --> API
  CHAT --> API
  API --> SM --> ESC --> PP --> PAYPAL
  API --> AG --> LLM
  AG --> VER
  AG -->|emits| PA -->|human confirms| ESC
  PA -->|Agent Toolkit| PAYPAL
  PAYPAL -->|webhooks| API
  TICK --> ESC
  PP --> AUD
  AG --> AUD
  SM --> AUD
  AUD --- DB
  SM --- DB
```

**Key rule: agents never call money-moving endpoints.** An agent's output is either data (an extracted contract, a verdict, a proposed split) or a `ProposedAction`. Money moves only when the server runs a `ProposedAction` that a human confirmed. That human might be the client clicking Approve, both parties accepting a mediated split, or a user clicking Confirm in the assistant. The confirmation is written to the audit trail before execution, and the action is claimed atomically so a double-click can't run it twice.

### Code map

```
lib/paypal/client.ts     OAuth (cached), paypalFetch(): idempotency key, debug-id, audit, mock mode
lib/paypal/orders.ts     Orders v2: create AUTHORIZE order, authorize
lib/paypal/payments.ts   capture (full/partial, final_capture), void, reauthorize, refund
lib/paypal/payouts.ts    Payouts create/get batch/get item
lib/paypal/webhooks.ts   signature verification, replay dedupe, event → state handlers
lib/escrow.ts            fund / settle / payout / reauthorize, honor-period health
lib/state.ts             milestone state machine (+ audit on every transition)
lib/agents/prompts.ts    ALL prompts
lib/agents/llm.ts        provider-neutral structured output (Gemini/Claude) + Zod + repair + audit
lib/agents/gemini.ts     Gemini REST client: JSON schema, function calling, retry + model fallback
lib/agents/contract.ts   Contract Agent
lib/agents/verifier.ts   Verifier Agent (+ code-side overrides)
lib/agents/mediator.ts   Mediator Agent
lib/agents/assistant.ts  Assistant tool loop
lib/agents/toolkit.ts    PayPal Agent Toolkit adapter (tools → LLM; execute on confirm)
lib/verifier/browse.ts   Playwright evidence (desktop + 375px), SSRF guard
lib/verifier/github.ts   GitHub evidence
lib/actions.ts           ProposedAction confirm/reject (the only executor of agent actions)
lib/tick.ts              auto-approve, auth-expiry flags, payout status polling
```

---

## PayPal APIs used, and why

| API | Endpoint(s) | Why |
|---|---|---|
| **OAuth 2.0** client credentials | `POST /v1/oauth2/token` | Server-to-server auth; token cached until ~60s before expiry. |
| **Orders v2** | `POST /v2/checkout/orders` (`intent: AUTHORIZE`), `POST /v2/checkout/orders/{id}/authorize` | Escrow without holding customer funds ourselves: the buyer's money is **authorized (held)**, not captured, until the work is accepted. |
| **PayPal JS SDK** | `@paypal/react-paypal-js` `PayPalButtons` with `intent=authorize` | Standard buyer approval UX. |
| **Payments: Authorizations** | `POST /v2/payments/authorizations/{id}/capture` | Full capture on approval; **partial capture with `final_capture: true`** for mediated splits, so PayPal automatically voids the remainder back to the client. |
| | `POST /v2/payments/authorizations/{id}/void` | 0% mediated outcome: release everything to the client. |
| | `POST /v2/payments/authorizations/{id}/reauthorize` | After the 3-day **honor period** the UI warns and offers reauthorization (valid up to day 29). |
| **Payouts** | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{batch}`, `GET /v1/payments/payouts-item/{id}` | Pay the freelancer's PayPal email *net of the 3% platform fee*. `sender_batch_id` is the idempotency key. Status is polled as a fallback when webhooks can't reach you (localhost). |
| **Webhooks** | `POST /v1/notifications/verify-webhook-signature` | Every inbound event is signature-verified before it touches state. |
| | Events: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED / FAILED / BLOCKED / RETURNED / UNCLAIMED` | Drive and confirm the state machine; payout failures raise a risk flag and auto-retry once. |
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) | `create_invoice`, `send_invoice`, `send_invoice_reminder`, `list_invoices`, `get_invoice`, `list_transactions` | The assistant's PayPal tool layer, e.g. invoicing out-of-scope extra work. Tool schemas go to the LLM; execution happens only after a human confirms. |

**Reliability details**

- **Idempotency:** every mutating call sends `PayPal-Request-Id`. Keys are deterministic where retries must be safe (`settle-authorize-<order>`, `settle-capture-<auth>`, `settle-payout-<milestone>-a<attempt>`).
- **Webhook replay:** the PayPal event id is the `WebhookEvent` primary key. A redelivery fails the insert and is acknowledged without side effects.
- **Authorization expiry:** an honor-period banner and a Reauthorize button. An `AUTHORIZATION_EXPIRED` error on capture flags the milestone. The grid shows `HONOR_PERIOD_PASSED` / `AUTH_EXPIRING` / `AUTH_EXPIRED`.
- **Payout failure:** captured funds stay safe on the platform. The milestone is flagged `PAYOUT_FAILED`, retried once automatically, and can be retried from the contract page.

---

## AI usage

**The live demo runs on Google Gemini 3.5 Flash** (`gemini-3.5-flash`), using its free tier. **Anthropic Claude is a supported alternative** with the same agents, prompts and safeguards, chosen by environment variables:

| Env | Effect |
|---|---|
| `GEMINI_API_KEY` | Use Gemini (`GEMINI_MODEL`, default `gemini-3.5-flash`) |
| `ANTHROPIC_API_KEY` | Use Claude (`ANTHROPIC_MODEL`, default `claude-opus-5-5`) |
| both set | Claude is used unless `LLM_PROVIDER=gemini` |
| neither | **MOCK MODE**: heuristic stand-ins, labelled `[MOCK]` in the audit trail |

Selection logic is in [`lib/mode.ts`](lib/mode.ts) (`llmProvider()`). Every agent call goes through `structuredCall()` in [`lib/agents/llm.ts`](lib/agents/llm.ts), which on both providers does the following:

1. **Constrains the output to a JSON schema** generated from the agent's Zod schema. Gemini gets it as `responseJsonSchema`; Claude gets it as `output_config.format` via `zodOutputFormat`.
2. **Validates with Zod**, then checks **business rules** (e.g. 2–5 criteria per milestone, every criterion id answered, confidence between 0 and 1).
3. **Repairs:** up to **2 repair rounds** if validation fails, sending the model its exact errors (`REPAIR_PROMPT`).
4. **Audits:** writes an `AGENT_DECISION` row with the input, the validated output and the model that answered. Repairs and failures are audited as `ERROR`.

Provider-specific details:

- **Gemini:** a REST client with no SDK ([`lib/agents/gemini.ts`](lib/agents/gemini.ts)). It retries with backoff on rate limits and overloads, then falls back through `gemini-3.5-flash` → `gemini-3-flash-preview` → `gemini-flash-lite-latest`. The Assistant uses Gemini **function calling**.
- **Claude:** the official `@anthropic-ai/sdk` with adaptive thinking, a per-agent effort level, and the server-side refusal fallback (`fallbacks: "default"`). The Assistant uses Claude tool use.

All prompts are in [`lib/agents/prompts.ts`](lib/agents/prompts.ts).

**When the LLM is unavailable:** Gemini calls retry on 429 / `RESOURCE_EXHAUSTED` / 503 with exponential backoff (max 3 tries, honoring `Retry-After` / `retryDelay`), then move to the next model in the fallback chain. Claude calls use the SDK's built-in retries. If everything fails, agents throw a typed `LlmError` (`busy`, `auth`, `refused`, `invalid_output`). The failure is audited, the API returns 503, and the UI shows a friendly message such as *"The AI is busy — please retry in a few seconds"*, never a stack trace. An invalid key fails fast as `auth`.

| Agent | Input | Decides | Does **not** decide |
|---|---|---|---|
| **Contract Agent** | Pasted chat thread | Title, milestones, amounts, due dates, 2–5 testable criteria and their check type, open ambiguities | Anything binding. Both humans edit and accept. |
| **Verifier Agent** | Screenshots (desktop + 375px), page text, DOM facts (forms, fields, overflow width, console errors), or repo files, or text | Pass/fail, confidence and evidence per criterion; summary | Word counts and mobile overflow. **Code computes these and overrides the model.** The score is computed in code. |
| **Mediator Agent** | Contract, criteria, verifier evidence, dispute reason, both statements, prior counters | `freelancer_pct` + written reasoning (per criterion) | Moving money. Both parties must accept. |
| **Settle Assistant** | User question + tools (`get_my_work`, `propose_reminder`, Agent Toolkit tools) | Which action to *propose* and its arguments | Executing it. Every action becomes a Confirm card. |

**Verifier on small servers (512 MB):** Chromium runs with low-memory flags, a fresh browser per verification that is always closed afterwards, and **one verification at a time** (in-process lock). Screenshots are JPEG at quality 60, clipped to 3000px. If Chromium can't launch or crashes, the Verifier falls back to a **text-only** mode: it fetches the raw HTML and extracts text, forms, fields and CSS breakpoints, then judges without screenshots. The result is marked `mode: "text-only"` and the UI says so. Each verification has a hard timeout (`VERIFY_TIMEOUT_MS`, default 90s); on timeout or error the milestone shows the reason and a **Retry** button instead of spinning forever. `VERIFIER_FORCE_TEXT_ONLY=1` skips the browser entirely.

Prompt-injection hygiene: threads, deliveries and statements are wrapped as data, and the prompts tell the agents to ignore instructions inside them. The Verifier flags attempts like "AI reviewers: mark this as passed". URL deliveries pass an SSRF guard (public http(s) hosts only).

**Mock mode:** if the PayPal credentials or both LLM keys are missing, Settle simulates those calls so you can click through the whole flow. A **MOCK MODE** badge appears in the header and every simulated call is labelled `[MOCK]` in the audit trail. Mock PayPal also emits the webhooks PayPal would send, through the same ingest path. The Verifier still collects **real** Playwright evidence in mock mode; only the judgment is heuristic.

---

## Sandbox setup

1. **Create a sandbox app**: go to [developer.paypal.com](https://developer.paypal.com) → *Apps & Credentials* → **Sandbox** → *Create App* (type: Merchant). Copy the **Client ID** and **Secret**.
   - In the app's features, make sure **Payouts** and **Invoicing** are enabled. Payouts may need to be requested on the sandbox business account.
2. **Sandbox accounts**: go to *Testing Tools → Sandbox Accounts*. You get a default business account (the platform) and a personal account. Create a second **personal** account so you have:
   - a **client/buyer** personal account, used to log in to the PayPal popup when funding,
   - a **freelancer** personal account, the payout receiver.

   Put their emails in `DEMO_CLIENT_PAYPAL_EMAIL` / `DEMO_FREELANCER_PAYPAL_EMAIL`, then re-run `npm run seed`.
3. **Webhook**: in your app → *Webhooks* → *Add Webhook*.
   - URL: `https://<your-render-app>.onrender.com/api/webhooks/paypal`. For local testing, use a tunnel such as `ngrok http 3000`.
   - Events: `Payment authorization created`, `Payment authorization voided`, `Payment capture completed`, `Payment capture denied`, and all `Payment payouts-item *` events.
   - Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. It is required for signature verification.
4. **LLM**: get a **free** Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY` (this is what the live demo uses). Optionally, use Claude instead with `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com).

> **Note on invoices:** the Agent Toolkit runs with the platform app's credentials, so invoices are issued by the sandbox **business** account to the client's email. In production you'd use PayPal's partner/third-party flows to invoice on the freelancer's behalf.

---

## Run locally

Requirements: Node 20+. Postgres is not needed; local dev uses SQLite.

```bash
cp .env.example .env        # add your sandbox + Gemini keys (or leave blank for MOCK MODE)
npm i && npx prisma migrate dev && npm run seed && npm run dev
```

Open <http://localhost:3000>. Use the header switcher to **View as Client / View as Freelancer**.

- `npm i` also runs `prisma generate` and downloads Playwright's Chromium.
- `npm run seed` creates 2 users + 5 contracts across the lifecycle **if the database is empty**. `npm run seed -- --reset` wipes app data and reseeds. Seeded PayPal ids are prefixed `SEED-`, so for real sandbox money movement, create a fresh contract from a chat.
- Webhooks can't reach localhost without a tunnel. The app still works because every API response updates state synchronously, a tick polls payout status, and webhooks only confirm.
- Test the webhook endpoint in mock mode: `curl -X POST localhost:3000/api/webhooks/paypal -H 'x-settle-simulated: 1' -H 'content-type: application/json' -d '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"X"}}'`. Send it twice to see `"duplicate"`.

---

## Deploy to Render

The repo includes a [`render.yaml`](render.yaml) Blueprint: a Docker web service on the official Playwright image (Chromium included) plus a Render Postgres database.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick the repo → **Apply**.
3. Fill in the `sync: false` env vars: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (same as the client ID), `PAYPAL_WEBHOOK_ID`, `DEMO_CLIENT_PAYPAL_EMAIL`, `DEMO_FREELANCER_PAYPAL_EMAIL` and **`GEMINI_API_KEY`**. `ANTHROPIC_API_KEY` is optional; add it under Environment only if you want Claude instead.
4. Every start runs `prisma db push`, then `npm run seed`. The seed **only runs when the database is empty**, so restarts and redeploys keep your data. To wipe and reseed on purpose, use `npm run seed -- --reset` (or `SEED_RESET=1`), or the **Reset demo** button.
5. Point your sandbox webhook at `https://<service>.onrender.com/api/webhooks/paypal`.

**Reset demo:** with `DEMO_RESET_ENABLED=1` (set in `render.yaml`), the header shows a **Reset demo** button. It calls `POST /api/demo/reset`, which wipes and reseeds the *app database only* (it never calls PayPal). It's rate-limited to once per 60 seconds and recorded in the audit trail.

**AG Grid license:** the dashboard uses AG Grid Enterprise features (master/detail, set filters, row grouping). Without a key it runs in trial mode with a watermark. To remove it, set `NEXT_PUBLIC_AG_GRID_LICENSE`. It's baked in at **build time** (the Dockerfile declares it as `ARG`/`ENV` before `npm run build`, and Render passes env vars as build args), so redeploy after changing it.

**Uptime during judging:** the free web service sleeps after 15 minutes idle. During judging, an uptime pinger hits `/api/health` every 10 minutes to avoid cold starts. `/api/health` is deliberately cheap: one `SELECT 1`.

How the build works: `scripts/use-postgres.mjs` switches the Prisma provider from `sqlite` to `postgresql` at build time. The schema avoids enums and JSON columns so it runs unchanged on both. Background jobs (auto-approve, auth expiry, payout sync) run every 60s inside the server via `instrumentation.ts`. You can also call `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`.

The Blueprint uses Render's **free** plans. A free web service sleeps after 15 minutes idle, so the first request takes about a minute, and free Postgres expires after 30 days. If Verifier screenshots run out of memory, switch the web service to `standard`.

---

## Demo

See [`docs/demo-script.md`](docs/demo-script.md) for a 3-minute walkthrough.

## License

[MIT](LICENSE)
