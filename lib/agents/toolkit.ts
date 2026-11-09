import type Anthropic from "@anthropic-ai/sdk";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { audit } from "../audit";
import { paypalMock } from "../mode";
import { mockId } from "../paypal/client";

/**
 * PayPal Agent Toolkit (@paypal/agent-toolkit) is the assistant's PayPal tool layer.
 * We take the toolkit's tool definitions (names + JSON schemas) and expose them to Claude,
 * but Claude's tool calls are NEVER executed directly: they become ProposedActions, and only
 * a human click on "Confirm" runs `executeToolkitCall` below.
 */

const CONFIG = {
  actions: {
    invoices: { create: true, list: true, get: true, send: true, sendReminder: true },
    transactions: { list: true },
  },
  context: { sandbox: (process.env.PAYPAL_API_BASE ?? "").includes("sandbox") || !process.env.PAYPAL_API_BASE },
};

let _toolkit: PayPalAgentToolkit | null = null;
function toolkit() {
  if (!_toolkit) {
    _toolkit = new PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID || "mock",
      clientSecret: process.env.PAYPAL_CLIENT_SECRET || "mock",
      configuration: CONFIG,
    });
  }
  return _toolkit;
}

export const TOOLKIT_TOOL_NAMES = ["create_invoice", "list_invoices", "get_invoice", "send_invoice", "send_invoice_reminder", "list_transactions"] as const;
export const READ_ONLY_TOOLKIT = new Set(["list_invoices", "get_invoice", "list_transactions"]);

/** Toolkit tools in Anthropic tool format. */
export function toolkitToolsForClaude(): Anthropic.Beta.BetaTool[] {
  return toolkit()
    .getTools()
    .filter((t) => (TOOLKIT_TOOL_NAMES as readonly string[]).includes(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: `[PayPal Agent Toolkit] ${t.function.description ?? ""}\nCalling this creates a PENDING action card; the user must click Confirm before it runs.`.slice(0, 1024),
      input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
    }));
}

export async function executeToolkitCall(
  name: string,
  args: Record<string, unknown>,
  ctx: { contractId?: string | null; milestoneId?: string | null; actor: string },
): Promise<unknown> {
  if (!(TOOLKIT_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`Toolkit tool ${name} is not enabled`);
  const started = Date.now();
  let result: unknown;
  if (paypalMock()) {
    result = mockToolkit(name, args);
  } else {
    const res = await toolkit().handleToolCall({ id: mockId("call"), type: "function", function: { name, arguments: JSON.stringify(args) } });
    try {
      result = JSON.parse(String(res.content));
    } catch {
      result = res.content;
    }
  }
  const r = result as { id?: string; href?: string } | undefined;
  await audit({
    ...ctx,
    kind: "PAYPAL_API",
    action: `${paypalMock() ? "[MOCK] " : ""}agent-toolkit.${name}`,
    summary: `${paypalMock() ? "[MOCK] " : ""}PayPal Agent Toolkit: ${name} executed after human confirmation`,
    resourceId: r?.id ?? (typeof r?.href === "string" ? r.href.split("/").pop() : null),
    durationMs: Date.now() - started,
    request: args,
    response: result,
  });
  return result;
}

function mockToolkit(name: string, args: Record<string, unknown>) {
  const inv = mockId("INV2-MOCK");
  switch (name) {
    case "create_invoice":
      return { rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${inv}`, method: "GET", id: inv, status: "DRAFT", args };
    case "send_invoice":
      return { rel: "payer-view", href: `https://www.sandbox.paypal.com/invoice/p/#${args.invoice_id ?? inv}` };
    case "send_invoice_reminder":
      return { status: 204 };
    case "list_invoices":
      return { total_items: 1, items: [{ id: inv, status: "SENT", amount: { currency_code: "USD", value: "150.00" } }] };
    case "list_transactions":
      return { transaction_details: [], total_items: 0 };
    default:
      return { ok: true };
  }
}
