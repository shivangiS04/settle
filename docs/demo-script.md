# Settle: 3-minute demo script

**Before you start**
- Click **Reset demo** in the header (or run `npm run seed -- --reset` locally), then open two tabs: **/** and the **Ops dashboard (/dashboard)**.
- Have the sandbox **client** personal-account login ready for the PayPal popup.
- Have a delivery URL ready. A small landing page with a contact form works well; `https://example.com` shows a failing verification.
- Header switcher set to **View as Client**.

---

### 0:00 to 0:20: The problem
> "Most freelance work gets agreed in a WhatsApp thread or an email. Freelancers get stiffed, clients pay upfront and hope, and when something goes wrong nobody can prove what was agreed. Settle is an AI escrow agent on PayPal for exactly these deals."

### 0:20 to 0:50: Chat → contract (Contract Agent)
1. **New from chat** → **Use sample thread** → **Extract contract with AI**.
2. Point out the milestones, amounts and due dates pulled from the thread. The acceptance criteria are *testable*: "contact form with name, email, message", "usable at 375px".
3. Point out the flagged ambiguity ("loads fast" has no target). Edit one criterion inline, then **Accept terms**.
4. Switch to **View as Freelancer** → **Accept terms** → status becomes **AGREED**.

> "Both sides sign off on exactly what 'done' means *before* any money moves."

### 0:50 to 1:15: Fund escrow (Orders v2, AUTHORIZE)
1. Switch to **Client** → on milestone 1, click the **PayPal** button → log in with the sandbox buyer → approve.
2. The status becomes **FUNDED**, with an authorization id on the card.

> "This is Orders v2 with intent AUTHORIZE. The money is *held* on the buyer's PayPal, not captured. Nobody can run off with it."

### 1:15 to 1:50: Deliver + AI verification (Verifier Agent)
1. Switch to **Freelancer** → **Live URL** → paste the site → **Submit for AI verification**.
2. The spinner shows headless Chromium loading the page at desktop and 375px. Gemini then judges each criterion from the screenshots and measured facts.
3. Walk through the results: ✓/✗ per criterion with evidence, confidence, the desktop and mobile screenshots, and the score bar.
4. Point at a code check: "word counts and mobile overflow width are *measured in code* and override the model".

### 1:50 to 2:20: Approve → capture + payout, or dispute → mediator
**Happy path:** switch to **Client** → **Approve & release**. The dialog shows capture $X, fee 3%, payout $Y → **SETTLED**. Webhooks arrive (`PAYMENT.CAPTURE.COMPLETED`, `PAYOUTS-ITEM.SUCCEEDED`).

**Or the dispute path.** With real sandbox keys, fund milestone 2 of the new contract, submit, then click **Dispute**. The freelancer's statement triggers the Mediator. Seeded contracts use fake `SEED-` PayPal ids, so the seeded "Mobile app landing page" dispute can only be settled in MOCK MODE.
- The Mediator Agent proposed **70/30** with reasoning tied to each criterion.
- Accept as **Client**, accept as **Freelancer**. That triggers a **partial capture with `final_capture=true`**: the freelancer is paid their share, and PayPal voids the remainder back to the client.

> "The AI proposes. Humans agree. Then, and only then, money moves."

### 2:20 to 2:45: Ops dashboard (/dashboard) + audit trail
1. Open the **Ops dashboard (/dashboard)** and expand a contract → milestones → per-criterion verifier results.
2. Show the colored status pills, score bars and risk flags (`PAYOUT_FAILED`, `HONOR_PERIOD_PASSED`), **Group by status**, and the pinned **TOTAL** row (held / paid out / fees).
3. Click a row to open the **Audit trail** side panel. It lists every agent decision and every PayPal call with its `PayPal-Request-Id`, resource id and debug id.

> "If an AI moves money, you have to be able to answer *why*. Here's the receipt for every step."

### 2:45 to 3:00: Assistant + Agent Toolkit
1. **Assistant** → "Create an invoice for $150 of out-of-scope extra work".
2. The assistant (Gemini) drafts a `create_invoice` call through the **PayPal Agent Toolkit** and it appears as a **PENDING** card. Click **Confirm** to execute it, and the call is logged in the audit trail.

> "Settle: chat to contract, PayPal escrow, AI verification, fair mediation, all explainable."

---

**Fallbacks if something misbehaves live**
- No network or no keys? The app runs in **MOCK MODE** (the header badge says so) with the same flow and audit trail, and calls labelled `[MOCK]`.
- The verifier is slow? Use a seeded contract that is already verified: "Portfolio site refresh".
- Payout failure story: the seeded "Fintech blog series" article 2 shows `PAYOUT_FAILED` with a retry button.
