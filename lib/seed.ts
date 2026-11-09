/**
 * Demo dataset: 2 users (mapped to PayPal sandbox personal accounts) + 5 contracts across the lifecycle,
 * with plausible audit history. Seeded PayPal ids are prefixed SEED- and seeded audit rows say "(seeded)".
 *
 * Used by scripts/seed.ts (CLI) and POST /api/demo/reset. Only touches the app database — never PayPal.
 */
import { prisma } from "./db";

const H = 3600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
const rid = (p: string) => `SEED-${p}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

type Crit = { text: string; checkType: string; minWords?: number };

/** Wipes ALL app data (never touches PayPal) and recreates the demo dataset. */
export async function resetAndSeed() {
  // wipe (children first)
  await prisma.$transaction([
    prisma.criterionResult.deleteMany(),
    prisma.screenshot.deleteMany(),
    prisma.verification.deleteMany(),
    prisma.mediationProposal.deleteMany(),
    prisma.dispute.deleteMany(),
    prisma.delivery.deleteMany(),
    prisma.criterion.deleteMany(),
    prisma.milestone.deleteMany(),
    prisma.proposedAction.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.contract.deleteMany(),
  ]);

  const clientEmail = process.env.DEMO_CLIENT_PAYPAL_EMAIL || "client-buyer@personal.example.com";
  const freelancerEmail = process.env.DEMO_FREELANCER_PAYPAL_EMAIL || "freelancer@personal.example.com";
  const client = await prisma.user.upsert({
    where: { email: "maya@client.demo" },
    update: { paypalEmail: clientEmail, name: "Maya Chen", role: "CLIENT" },
    create: { name: "Maya Chen", email: "maya@client.demo", role: "CLIENT", paypalEmail: clientEmail },
  });
  const freelancer = await prisma.user.upsert({
    where: { email: "dev@freelancer.demo" },
    update: { paypalEmail: freelancerEmail, name: "Arjun Rao", role: "FREELANCER" },
    create: { name: "Arjun Rao", email: "dev@freelancer.demo", role: "FREELANCER", paypalEmail: freelancerEmail },
  });

  const ev = (contractId: string, milestoneId: string | null, at: Date, actor: string, kind: string, action: string, summary: string, extra: Record<string, unknown> = {}) =>
    prisma.auditEvent.create({ data: { contractId, milestoneId, createdAt: at, actor, kind, action, summary: `${summary} (seeded)`, ...extra } });

  async function contract(o: { title: string; summary: string; thread: string; status: string; createdAgo: number; accepted: [boolean, boolean]; ambiguities?: string[] }) {
    const c = await prisma.contract.create({
      data: {
        title: o.title,
        summary: o.summary,
        rawThread: o.thread,
        status: o.status,
        clientId: client.id,
        freelancerId: freelancer.id,
        clientAcceptedAt: o.accepted[0] ? ago(o.createdAgo - H) : null,
        freelancerAcceptedAt: o.accepted[1] ? ago(o.createdAgo - 2 * H) : null,
        extractionJson: JSON.stringify({ ambiguities: o.ambiguities ?? [], model: "seed" }),
        createdAt: ago(o.createdAgo),
      },
    });
    await ev(c.id, null, ago(o.createdAgo), "agent:contract", "AGENT_DECISION", "contract.decide", `Contract Agent extracted terms from the pasted thread`);
    if (o.accepted[0]) await ev(c.id, null, ago(o.createdAgo - H), `user:${client.id}`, "HUMAN_ACTION", "contract.accept", "Maya Chen (client) accepted the terms");
    if (o.accepted[1]) await ev(c.id, null, ago(o.createdAgo - 2 * H), `user:${freelancer.id}`, "HUMAN_ACTION", "contract.accept", "Arjun Rao (freelancer) accepted the terms");
    return c;
  }

  async function milestone(contractId: string, idx: number, o: { title: string; amount: number; status: string; due?: Date; criteria: Crit[]; extra?: Record<string, unknown> }) {
    return prisma.milestone.create({
      data: {
        contractId,
        idx,
        title: o.title,
        amountCents: Math.round(o.amount * 100),
        status: o.status,
        dueDate: o.due ?? null,
        criteria: { create: o.criteria.map((c, j) => ({ idx: j, text: c.text, checkType: c.checkType, minWords: c.minWords ?? null })) },
        ...(o.extra ?? {}),
      },
      include: { criteria: { orderBy: { idx: "asc" } } },
    });
  }

  async function fund(m: { id: string; contractId: string; amountCents: number }, at: Date) {
    const order = rid("ORDER");
    const auth = rid("AUTH");
    await prisma.milestone.update({
      where: { id: m.id },
      data: {
        paypalOrderId: order,
        authorizationId: auth,
        authStatus: "CREATED",
        authCreatedAt: at,
        honorPeriodEndsAt: new Date(at.getTime() + 3 * D),
        authExpiresAt: new Date(at.getTime() + 29 * D),
        lastPaypalEvent: "PAYMENT.AUTHORIZATION.CREATED",
        lastPaypalEventAt: at,
      },
    });
    const v = (m.amountCents / 100).toFixed(2);
    await ev(m.contractId, m.id, at, `user:${client.id}`, "PAYPAL_API", "POST /v2/checkout/orders", `Create AUTHORIZE order (${v} USD)`, { requestId: `settle-order-${m.id}`, resourceId: order, httpStatus: 201, durationMs: 412 });
    await ev(m.contractId, m.id, new Date(at.getTime() + 40_000), `user:${client.id}`, "PAYPAL_API", `POST /v2/checkout/orders/${order}/authorize`, `Authorize order — ${v} USD held in escrow`, { requestId: `settle-authorize-${order}`, resourceId: auth, httpStatus: 201, durationMs: 655 });
    await ev(m.contractId, m.id, new Date(at.getTime() + 45_000), "paypal:webhook", "WEBHOOK", "PAYMENT.AUTHORIZATION.CREATED", `Webhook PAYMENT.AUTHORIZATION.CREATED`, { resourceId: auth });
    return auth;
  }

  async function verify(m: { id: string; contractId: string; criteria: { id: string }[] }, at: Date, url: string, verdicts: [boolean, number, string][], summary: string) {
    const d = await prisma.delivery.create({ data: { milestoneId: m.id, type: url.startsWith("http") ? (url.includes("github.com") ? "GITHUB" : "URL") : "TEXT", content: url, createdAt: at } });
    const passed = verdicts.filter((v) => v[0]).length;
    const score = Math.round((passed / verdicts.length) * 1000) / 10;
    await prisma.verification.create({
      data: {
        milestoneId: m.id,
        deliveryId: d.id,
        scorePct: score,
        summary,
        model: "claude-opus-5-5 (seeded)",
        createdAt: new Date(at.getTime() + 50_000),
        results: { create: verdicts.map(([p, conf, evid], i) => ({ criterionId: m.criteria[i].id, passed: p, confidence: conf, evidence: evid })) },
      },
    });
    await prisma.milestone.update({ where: { id: m.id }, data: { verifierScore: score } });
    await ev(m.contractId, m.id, at, `user:${freelancer.id}`, "HUMAN_ACTION", "delivery.submit", `Freelancer submitted a delivery: ${url.slice(0, 80)}`);
    await ev(m.contractId, m.id, new Date(at.getTime() + 50_000), "agent:verifier", "AGENT_DECISION", "verifier.decide", `Verifier Agent: ${score}% (${passed}/${verdicts.length}) — ${summary}`);
    return { delivery: d, score };
  }

  async function settle(m: { id: string; contractId: string; amountCents: number; authorizationId?: string | null }, at: Date, freelancerCents: number, payoutStatus: "SUCCESS" | "FAILED", source: string) {
    const fee = Math.round(freelancerCents * 0.03);
    const cap = rid("CAP");
    const batch = rid("BATCH");
    await prisma.milestone.update({
      where: { id: m.id },
      data: {
        status: "SETTLED",
        stateChangedAt: at,
        authStatus: freelancerCents === m.amountCents ? "CAPTURED" : "PARTIALLY_CAPTURED",
        captureId: cap,
        capturedCents: freelancerCents,
        releasedCents: m.amountCents - freelancerCents,
        feeCents: fee,
        payoutCents: freelancerCents - fee,
        payoutBatchId: batch,
        payoutItemId: rid("ITEM"),
        payoutStatus,
        payoutAttempts: payoutStatus === "FAILED" ? 2 : 1,
        riskFlag: payoutStatus === "FAILED" ? "PAYOUT_FAILED" : null,
        lastPaypalEvent: payoutStatus === "FAILED" ? "PAYMENT.PAYOUTS-ITEM.FAILED" : "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        lastPaypalEventAt: new Date(at.getTime() + 120_000),
      },
    });
    const v = (x: number) => (x / 100).toFixed(2);
    await prisma.proposedAction.create({
      data: {
        contractId: m.contractId,
        milestoneId: m.id,
        source,
        type: freelancerCents === m.amountCents ? "CAPTURE_AND_PAYOUT" : "PARTIAL_SETTLE",
        title: freelancerCents === m.amountCents ? `Release ${v(m.amountCents)} USD` : `Settle: ${Math.round((freelancerCents / m.amountCents) * 100)}% to freelancer`,
        status: "EXECUTED",
        confirmedBy: source === "agent:mediator" ? "both-parties" : client.id,
        createdAt: at,
        executedAt: at,
      },
    });
    await ev(m.contractId, m.id, at, `user:${client.id}`, "PAYPAL_API", `POST /v2/payments/authorizations/${m.authorizationId}/capture`, `Capture ${v(freelancerCents)} USD (final_capture=true)`, { requestId: `settle-capture-${m.authorizationId}`, resourceId: cap, httpStatus: 201, durationMs: 803 });
    await ev(m.contractId, m.id, new Date(at.getTime() + 2000), `user:${client.id}`, "PAYPAL_API", "POST /v1/payments/payouts", `Payout ${v(freelancerCents - fee)} USD → ${freelancerEmail} (fee ${v(fee)})`, { requestId: `settle-payout-${m.id}-a1`, resourceId: batch, httpStatus: 201, durationMs: 590 });
    await ev(m.contractId, m.id, new Date(at.getTime() + 60_000), "paypal:webhook", "WEBHOOK", "PAYMENT.CAPTURE.COMPLETED", "Webhook PAYMENT.CAPTURE.COMPLETED", { resourceId: cap });
    if (freelancerCents < m.amountCents) await ev(m.contractId, m.id, new Date(at.getTime() + 70_000), "paypal:webhook", "WEBHOOK", "PAYMENT.AUTHORIZATION.VOIDED", `Remainder ${v(m.amountCents - freelancerCents)} USD released to client`);
    if (payoutStatus === "FAILED") {
      await ev(m.contractId, m.id, new Date(at.getTime() + 120_000), "paypal:webhook", "ERROR", "payout.failed", "Payout FAILED: RECEIVER_UNCONFIRMED. Captured funds are safe; retry from the dashboard.");
    } else {
      await ev(m.contractId, m.id, new Date(at.getTime() + 120_000), "paypal:webhook", "WEBHOOK", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "Webhook PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    }
  }

  // ---------- 1. DRAFT ----------
  const c1 = await contract({
    title: "Brewline landing page + launch post",
    summary: "Landing page for a coffee-subscription brand with plan cards and a contact form, plus a 1500-word launch blog post.",
    thread: "Maya: We need a landing page for Brewline — hero, 3 plan cards, contact form, must look right on phones.\nArjun: $600 for the page by Nov 20, then a 1500-word launch post for $250 by Nov 27.\nMaya: Deal, let's use Settle.",
    status: "DRAFT",
    createdAgo: 3 * H,
    accepted: [true, false],
    ambiguities: ['"Loads fast" was mentioned but no target was agreed — consider "Lighthouse performance ≥ 80 on mobile".'],
  });
  await milestone(c1.id, 0, {
    title: "Landing page design + build",
    amount: 600,
    status: "DRAFT",
    due: ahead(11 * D),
    criteria: [
      { text: "Hero section with tagline and a 'Start subscription' call-to-action button", checkType: "VISUAL" },
      { text: "Three plan cards: Starter $12, Daily $24, Office $60", checkType: "CONTENT" },
      { text: "Working contact form with name, email and message fields", checkType: "FUNCTIONAL" },
      { text: "Usable at 375px width with no horizontal scrolling", checkType: "VISUAL" },
    ],
  });
  await milestone(c1.id, 1, {
    title: "Launch blog post",
    amount: 250,
    status: "DRAFT",
    due: ahead(18 * D),
    criteria: [
      { text: "At least 1500 words", checkType: "WORD_COUNT", minWords: 1500 },
      { text: 'About "why freshly roasted beans matter", with intro, 3+ sections and a conclusion', checkType: "CONTENT" },
    ],
  });

  // ---------- 2. AGREED (ready to fund) ----------
  const c2 = await contract({
    title: "Podcast show notes — November batch",
    summary: "Show notes for four podcast episodes, each with summary, timestamps and links.",
    thread: "Maya: Can you write show notes for eps 41–44? $90 each.\nArjun: Sure — two milestones, eps 41–42 then 43–44.",
    status: "AGREED",
    createdAgo: 1 * D,
    accepted: [true, true],
  });
  for (const [i, t] of ["Episodes 41–42", "Episodes 43–44"].entries())
    await milestone(c2.id, i, {
      title: t,
      amount: 180,
      status: "AGREED",
      due: ahead((7 + 7 * i) * D),
      criteria: [
        { text: "Each episode has a 150–250 word summary", checkType: "CONTENT" },
        { text: "Each episode has at least 5 timestamps", checkType: "CONTENT" },
        { text: "All guest links included and working", checkType: "FUNCTIONAL" },
      ],
    });

  // ---------- 3. ACTIVE: funded (honor period passed) + verified 100% (auto-approve pending) ----------
  const c3 = await contract({
    title: "Portfolio site refresh",
    summary: "Refresh of an architecture studio's portfolio site: new project gallery and a mobile-friendly about page.",
    thread: "Maya: Our portfolio site needs a refresh — gallery + about page. Arjun: $1,200 in two parts.",
    status: "ACTIVE",
    createdAgo: 8 * D,
    accepted: [true, true],
  });
  const m31 = await milestone(c3.id, 0, {
    title: "Project gallery",
    amount: 700,
    status: "VERIFIED",
    criteria: [
      { text: "Gallery shows at least 12 projects with captions", checkType: "CONTENT" },
      { text: "Clicking a project opens a detail view with 3+ images", checkType: "FUNCTIONAL" },
      { text: "Gallery is a single column at 375px with no horizontal scroll", checkType: "VISUAL" },
    ],
    extra: { stateChangedAt: ago(6 * H), autoApproveAt: ahead(42 * H) },
  });
  const a31 = await fund(m31, ago(6 * D));
  await verify({ ...m31 }, ago(6 * H), "https://studio-portfolio-demo.vercel.app/gallery", [
    [true, 0.94, "16 project cards with captions found in the gallery grid."],
    [true, 0.82, "Project links lead to /projects/<slug> pages with 4–7 images each."],
    [true, 0.97, "Measured page width at 375px is 375px (no overflow); grid collapses to one column in the mobile screenshot."],
  ], "All three criteria are met; the gallery is complete and responsive.");
  await prisma.milestone.update({ where: { id: m31.id }, data: { authorizationId: a31 } });
  const m32 = await milestone(c3.id, 1, {
    title: "About page",
    amount: 500,
    status: "FUNDED",
    due: ahead(5 * D),
    criteria: [
      { text: "About page includes team bios for all 4 partners", checkType: "CONTENT" },
      { text: "Includes an embedded map of the studio location", checkType: "VISUAL" },
    ],
    extra: { stateChangedAt: ago(5 * D), riskFlag: "HONOR_PERIOD_PASSED" },
  });
  await fund(m32, ago(5 * D));
  await ev(c3.id, m32.id, ago(2 * D), "system", "STATE_CHANGE", "risk.flag", "About page: 3-day honor period has passed — reauthorize to re-guarantee funds");

  // ---------- 4. DISPUTED (mediation round 1 awaiting responses) ----------
  const c4 = await contract({
    title: "Mobile app landing page",
    summary: "Marketing landing page for a habit-tracking app with app-store badges and an email waitlist.",
    thread: "Maya: Landing page for our habit app, with App Store/Play badges and a waitlist form. $900.\nArjun: Deal.",
    status: "ACTIVE",
    createdAgo: 12 * D,
    accepted: [true, true],
  });
  const m41 = await milestone(c4.id, 0, {
    title: "Landing page",
    amount: 900,
    status: "DISPUTED",
    criteria: [
      { text: "App Store and Google Play badges link to the store listings", checkType: "FUNCTIONAL" },
      { text: "Email waitlist form with a single email field and submit button", checkType: "FUNCTIONAL" },
      { text: "Usable at 375px width with no horizontal scrolling", checkType: "VISUAL" },
      { text: "Includes 3 feature sections with screenshots", checkType: "VISUAL" },
    ],
    extra: { stateChangedAt: ago(20 * H), riskFlag: "LOW_SCORE" },
  });
  await fund(m41, ago(10 * D));
  await verify({ ...m41 }, ago(2 * D), "https://habitly-landing-demo.netlify.app", [
    [true, 0.9, "Both badges present; links point to apps.apple.com and play.google.com."],
    [true, 0.85, "Form with one email input and 'Join waitlist' button found."],
    [false, 0.95, "[Code check] At 375px the page is 512px wide (horizontal scroll) — the feature carousel overflows."],
    [false, 0.7, "Only 2 feature sections found in the desktop screenshot; the third is a placeholder."],
  ], "Store badges and waitlist work, but the mobile layout overflows and one feature section is missing.");
  const dsp = await prisma.dispute.create({
    data: {
      milestoneId: m41.id,
      reason: "Page scrolls sideways on my iPhone and the third feature section is lorem ipsum",
      clientStatement: "Mobile is 80% of our traffic, this is not shippable as-is.",
      freelancerStatement: "The carousel issue is a 10-minute fix and the third section is waiting on screenshots the client never sent.",
      status: "PROPOSED",
      round: 1,
      createdAt: ago(20 * H),
    },
  });
  await prisma.mediationProposal.create({
    data: {
      disputeId: dsp.id,
      round: 1,
      freelancerPct: 70,
      reasoning:
        "Two of four criteria are clearly met (store badges, waitlist form) and these carry most of the page's conversion value. The mobile overflow is a real defect on a criterion the client stressed, but it is narrow and quickly fixable. The missing third feature section appears to depend on assets the client was expected to provide. A 70/30 split reflects substantial, working delivery while compensating the client for the unfinished mobile polish.\n\n• Store badges: met — full weight\n• Waitlist form: met — full weight\n• 375px layout: not met — main reason for the reduction\n• 3 feature sections: partly blocked on client assets — small reduction",
      createdAt: ago(19 * H),
    },
  });
  await ev(c4.id, m41.id, ago(20 * H), `user:${client.id}`, "HUMAN_ACTION", "dispute.open", 'Client disputed: "Page scrolls sideways on my iPhone…"');
  await ev(c4.id, m41.id, ago(19 * H), "agent:mediator", "AGENT_DECISION", "mediator.decide", "Mediator Agent round 1: proposed 70% freelancer / 30% client");

  // ---------- 5. COMPLETED (full settle + mediated partial with failed payout) ----------
  const c5 = await contract({
    title: "Fintech blog series",
    summary: "Two long-form articles on personal-finance automation for a fintech startup's blog.",
    thread: "Maya: Two 2000-word articles on finance automation, $400 each. Arjun: Deal.",
    status: "COMPLETED",
    createdAgo: 25 * D,
    accepted: [true, true],
  });
  const m51 = await milestone(c5.id, 0, {
    title: "Article 1: Automating your savings",
    amount: 400,
    status: "SETTLED",
    criteria: [
      { text: "At least 2000 words", checkType: "WORD_COUNT", minWords: 2000 },
      { text: "Covers round-ups, scheduled transfers and high-yield accounts", checkType: "CONTENT" },
    ],
  });
  const a51 = await fund(m51, ago(24 * D));
  await verify({ ...m51 }, ago(18 * D), "Automating your savings is the single most effective…", [
    [true, 1, "Word count computed in code: 2,184 (minimum 2000)."],
    [true, 0.93, "Dedicated sections for round-ups, scheduled transfers and HYSAs."],
  ], "Meets both criteria.");
  await settle({ ...m51, authorizationId: a51 }, ago(17 * D), 40000, "SUCCESS", "user");
  const m52 = await milestone(c5.id, 1, {
    title: "Article 2: Budgeting apps compared",
    amount: 400,
    status: "SETTLED",
    criteria: [
      { text: "At least 2000 words", checkType: "WORD_COUNT", minWords: 2000 },
      { text: "Compares at least 5 budgeting apps in a table", checkType: "CONTENT" },
      { text: "Includes a conclusion with a recommendation per user type", checkType: "CONTENT" },
    ],
  });
  const a52 = await fund(m52, ago(16 * D));
  await verify({ ...m52 }, ago(9 * D), "Budgeting apps compared: …", [
    [false, 1, "Word count computed in code: 1,612 (minimum 2000)."],
    [true, 0.9, "Comparison table with 6 apps."],
    [true, 0.8, "Conclusion recommends apps for students, families and freelancers."],
  ], "Comparison and conclusion are solid but the article is ~400 words short.");
  const d52 = await prisma.dispute.create({
    data: { milestoneId: m52.id, reason: "Article is 400 words short", status: "AGREED", round: 1, agreedFreelancerPct: 85, createdAt: ago(8 * D) },
  });
  await prisma.mediationProposal.create({
    data: {
      disputeId: d52.id,
      round: 1,
      freelancerPct: 85,
      reasoning: "Two of three criteria fully met; the length shortfall is ~20% but the content requirements that matter most to readers are covered. 85/15 compensates the client proportionally.",
      clientResponse: "ACCEPT",
      freelancerResponse: "ACCEPT",
      createdAt: ago(8 * D),
    },
  });
  await settle({ ...m52, authorizationId: a52 }, ago(7 * D), 34000, "FAILED", "agent:mediator");

  const counts = await Promise.all([prisma.contract.count(), prisma.milestone.count(), prisma.auditEvent.count()]);
  return { users: [client.paypalEmail, freelancer.paypalEmail], contracts: counts[0], milestones: counts[1], auditEvents: counts[2] };
}

/** Seeds only when the database has no users and no contracts. Safe to run on every boot. */
export async function seedIfEmpty() {
  const [users, contracts] = await Promise.all([prisma.user.count(), prisma.contract.count()]);
  if (users > 0 || contracts > 0) return { seeded: false as const, users, contracts };
  return { seeded: true as const, ...(await resetAndSeed()) };
}
