import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db";
import { audit } from "../audit";
import { anthropic, MODEL } from "./llm";
import { ASSISTANT_SYSTEM } from "./prompts";
import { toolkitToolsForClaude, TOOLKIT_TOOL_NAMES } from "./toolkit";
import { llmMock, llmProvider } from "../mode";
import { geminiGenerate, geminiText, type GContent } from "./gemini";
import { authHealth } from "../escrow";
import { centsToValue } from "../utils";

type ChatTurn = { role: "user" | "assistant"; content: string };
type User = { id: string; name: string; role: string; paypalEmail: string };

const CUSTOM_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_my_work",
    description: "Read the current user's contracts and milestones: status, amounts held/paid, what is waiting on whom, counterparty names and PayPal emails, escrow warnings. Read-only; runs immediately.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "propose_reminder",
    description: "Draft a reminder message to the other party of a contract (e.g. ask the client to review a delivery or fund a milestone). Creates a PENDING action card; the user must click Confirm before it is sent.",
    input_schema: {
      type: "object",
      properties: {
        contract_id: { type: "string", description: "Contract id from get_my_work" },
        milestone_id: { type: ["string", "null"], description: "Milestone id, if the reminder is about one milestone" },
        message: { type: "string", description: "The reminder text, friendly and specific, under 600 characters" },
      },
      required: ["contract_id", "milestone_id", "message"],
      additionalProperties: false,
    },
    strict: true,
  },
];

async function getMyWork(user: User) {
  const contracts = await prisma.contract.findMany({
    where: user.role === "CLIENT" ? { clientId: user.id } : { freelancerId: user.id },
    include: { client: true, freelancer: true, milestones: { orderBy: { idx: "asc" }, include: { disputes: { take: 1, orderBy: { createdAt: "desc" } } } } },
    orderBy: { updatedAt: "desc" },
  });
  const waitingOn = (status: string, isClient: boolean) => {
    const clientTurn = ["AGREED", "SUBMITTED", "VERIFIED"].includes(status);
    const freelancerTurn = ["FUNDED"].includes(status);
    if (status === "DISPUTED") return "both (mediation)";
    if (clientTurn) return isClient ? "YOU" : "client";
    if (freelancerTurn) return isClient ? "freelancer" : "YOU";
    return "nobody";
  };
  return contracts.map((c) => ({
    contract_id: c.id,
    title: c.title,
    status: c.status,
    you_are: user.role.toLowerCase(),
    counterparty: user.role === "CLIENT" ? { name: c.freelancer.name, paypal_email: c.freelancer.paypalEmail } : { name: c.client.name, paypal_email: c.client.paypalEmail },
    acceptance: c.status === "DRAFT" ? { client: !!c.clientAcceptedAt, freelancer: !!c.freelancerAcceptedAt } : undefined,
    milestones: c.milestones.map((m) => ({
      milestone_id: m.id,
      title: m.title,
      amount: `${centsToValue(m.amountCents)} ${m.currency}`,
      status: m.status,
      waiting_on: c.status === "DRAFT" ? "acceptance" : waitingOn(m.status, user.role === "CLIENT"),
      due: m.dueDate?.toISOString().slice(0, 10) ?? null,
      verifier_score: m.verifierScore,
      paid_out: m.payoutCents ? `${centsToValue(m.payoutCents)} ${m.currency} (${m.payoutStatus})` : null,
      escrow_warning: authHealth(m).level !== "ok" ? authHealth(m) : null,
      risk: m.riskFlag,
      dispute: m.disputes[0] ? { status: m.disputes[0].status, reason: m.disputes[0].reason } : null,
    })),
  }));
}

export async function runAssistant(user: User, history: ChatTurn[]) {
  const proposed: string[] = [];
  const ctx = `User: ${user.name} (${user.role.toLowerCase()}), PayPal email ${user.paypalEmail}. Today: ${new Date().toISOString().slice(0, 10)}. PayPal environment: sandbox.`;

  if (llmMock()) return mockAssistant(user, history);
  if (llmProvider() === "gemini") return runAssistantGemini(user, history, ctx, proposed);

  const tools = [...CUSTOM_TOOLS, ...toolkitToolsForClaude()];
  const messages: Anthropic.Beta.BetaMessageParam[] = history.slice(-20).map((t) => ({ role: t.role, content: t.content }));
  let reply = "";

  for (let i = 0; i < 6; i++) {
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: ASSISTANT_SYSTEM(ctx),
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    messages.push({ role: "assistant", content: res.content });
    reply = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (res.stop_reason === "refusal") return { reply: "Sorry — I can't help with that request.", proposed };
    if (res.stop_reason !== "tool_use") break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      try {
        const out = await handleTool(user, b.name, b.input as Record<string, unknown>, proposed);
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: (e as Error).message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: reply || "Done.", proposed };
}

/** Same loop on Gemini (free tier) using function calling. */
async function runAssistantGemini(user: User, history: ChatTurn[], ctx: string, proposed: string[]) {
  const tools = [...CUSTOM_TOOLS, ...toolkitToolsForClaude()].map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema,
  }));
  const contents: GContent[] = history.slice(-20).map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
  let reply = "";
  for (let i = 0; i < 6; i++) {
    const res = await geminiGenerate({ system: ASSISTANT_SYSTEM(ctx), contents, tools });
    const content = res.candidates?.[0]?.content;
    if (!content) return { reply: "Sorry — I couldn't answer that.", proposed };
    contents.push(content); // keep parts as-is (thought signatures must be replayed)
    reply = geminiText(res).trim();
    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) break;
    const responses = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      try {
        const out = await handleTool(user, fc.name, fc.args ?? {}, proposed);
        responses.push({ functionResponse: { name: fc.name, id: fc.id, response: { result: out } } });
      } catch (e) {
        responses.push({ functionResponse: { name: fc.name, id: fc.id, response: { error: (e as Error).message } } });
      }
    }
    contents.push({ role: "user", parts: responses });
  }
  return { reply: reply || "Done.", proposed };
}

async function handleTool(user: User, name: string, input: Record<string, unknown>, proposed: string[]) {
  if (name === "get_my_work") return getMyWork(user);

  if (name === "propose_reminder") {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: String(input.contract_id) } });
    if (c.clientId !== user.id && c.freelancerId !== user.id) throw new Error("Not your contract");
    const pa = await prisma.proposedAction.create({
      data: {
        contractId: c.id,
        milestoneId: (input.milestone_id as string | null) ?? null,
        source: "agent:assistant",
        type: "SEND_REMINDER",
        title: `Send reminder to ${user.role === "CLIENT" ? "freelancer" : "client"}`,
        paramsJson: JSON.stringify({ message: String(input.message).slice(0, 600), toUserId: user.id === c.clientId ? c.freelancerId : c.clientId }),
        rationale: "Drafted by the Settle Assistant at the user's request",
        requestedFor: user.id,
      },
    });
    await logProposal(pa.id, c.id, pa.title, input);
    proposed.push(pa.id);
    return { status: "PENDING_CONFIRMATION", action_id: pa.id, note: "Tell the user to review and click Confirm on the action card." };
  }

  if ((TOOLKIT_TOOL_NAMES as readonly string[]).includes(name)) {
    const pa = await prisma.proposedAction.create({
      data: {
        source: "agent:assistant",
        type: "TOOLKIT_CALL",
        title: describeToolkit(name, input),
        paramsJson: JSON.stringify({ tool: name, args: input }),
        rationale: "Proposed by the Settle Assistant via the PayPal Agent Toolkit",
        requestedFor: user.id,
      },
    });
    await logProposal(pa.id, null, pa.title, { tool: name, args: input });
    proposed.push(pa.id);
    return { status: "PENDING_CONFIRMATION", action_id: pa.id, note: "Nothing has been sent to PayPal yet. Tell the user to click Confirm on the action card." };
  }
  throw new Error(`Unknown tool ${name}`);
}

async function logProposal(id: string, contractId: string | null, title: string, input: unknown) {
  await audit({ contractId, actor: "agent:assistant", kind: "AGENT_DECISION", action: "assistant.propose", summary: `Assistant proposed: ${title} (awaiting human confirmation)`, resourceId: id, request: input });
}

function describeToolkit(name: string, a: Record<string, unknown>) {
  const amt = (a.items as { unit_amount?: { value?: string }; quantity?: string }[] | undefined)?.reduce((s, i) => s + Number(i.unit_amount?.value ?? 0) * Number(i.quantity ?? 1), 0);
  switch (name) {
    case "create_invoice":
      return `Create PayPal invoice${amt ? ` for ${amt.toFixed(2)} ${a.currency_code ?? "USD"}` : ""}${a.recipient_email ? ` to ${a.recipient_email}` : ""}`;
    case "send_invoice":
      return `Send PayPal invoice ${a.invoice_id ?? ""}`;
    case "send_invoice_reminder":
      return `Send PayPal invoice reminder ${a.invoice_id ?? ""}`;
    case "list_invoices":
      return "List my PayPal invoices";
    case "get_invoice":
      return `Get PayPal invoice ${a.invoice_id ?? ""}`;
    case "list_transactions":
      return "List PayPal transactions";
    default:
      return name;
  }
}

/** MOCK mode: tiny intent router so the chat still demonstrates the propose→confirm loop. */
async function mockAssistant(user: User, history: ChatTurn[]) {
  const q = history[history.length - 1]?.content.toLowerCase() ?? "";
  const proposed: string[] = [];
  const work = await getMyWork(user);
  if (/invoice|extra|out.of.scope/.test(q)) {
    const c = work[0];
    const amount = Number(q.match(/\$?(\d+(?:\.\d+)?)/)?.[1] ?? 150);
    const out = await handleTool(
      user,
      "create_invoice",
      {
        currency_code: "USD",
        recipient_email: c?.counterparty.paypal_email ?? "client@example.com",
        items: [{ name: "Out-of-scope extra work", quantity: "1", unit_amount: { currency_code: "USD", value: amount.toFixed(2) } }],
        note: `Extra work on ${c?.title ?? "the project"}`,
      },
      proposed,
    );
    return { reply: `[MOCK] I drafted a PayPal invoice for $${amount.toFixed(2)} to ${c?.counterparty.paypal_email}. It's waiting for you — click **Confirm** to create it via the PayPal Agent Toolkit. (action ${(out as { action_id: string }).action_id})`, proposed };
  }
  if (/remind/.test(q)) {
    const c = work.find((w) => w.milestones.some((m) => m.waiting_on !== "YOU" && m.waiting_on !== "nobody")) ?? work[0];
    if (!c) return { reply: "[MOCK] You have no contracts yet.", proposed };
    const m = c.milestones.find((x) => x.waiting_on !== "nobody");
    await handleTool(user, "propose_reminder", { contract_id: c.contract_id, milestone_id: m?.milestone_id ?? null, message: `Hi ${c.counterparty.name}, friendly nudge on "${m?.title ?? c.title}" — it's currently ${m?.status}. Could you take a look when you get a chance? Thanks!` }, proposed);
    return { reply: `[MOCK] I drafted a reminder to ${c.counterparty.name}. Review it and click **Confirm** to send.`, proposed };
  }
  const lines = work.flatMap((c) => c.milestones.filter((m) => m.waiting_on === "YOU").map((m) => `• **${c.title} — ${m.title}** (${m.amount}): ${m.status}`));
  return {
    reply: lines.length ? `[MOCK] Waiting on you:\n${lines.join("\n")}` : "[MOCK] Nothing is waiting on you right now.",
    proposed,
  };
}
