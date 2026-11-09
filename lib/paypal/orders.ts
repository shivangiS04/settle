import { paypalFetch, mockId, type CallCtx } from "./client";

export type Money = { currency_code: string; value: string };

export type PayPalOrder = {
  id: string;
  status: string;
  intent?: string;
  links?: { href: string; rel: string }[];
  purchase_units?: {
    reference_id?: string;
    amount?: Money;
    payments?: {
      authorizations?: Authorization[];
      captures?: { id: string; status: string; amount: Money }[];
    };
  }[];
};

export type Authorization = {
  id: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | DENIED | EXPIRED
  amount: Money;
  expiration_time?: string;
  create_time?: string;
};

/** Orders v2 with intent=AUTHORIZE — funds are held on the buyer, not captured. */
export function createAuthorizeOrder(
  args: { milestoneId: string; contractId: string; title: string; amount: Money; payeeNote?: string },
  ctx: Omit<CallCtx, "summary">,
) {
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: args.milestoneId,
        custom_id: args.milestoneId,
        description: `Settle escrow: ${args.title}`.slice(0, 127),
        soft_descriptor: "SETTLE ESCROW",
        amount: args.amount,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Settle Escrow",
          user_action: "CONTINUE",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };
  return paypalFetch<PayPalOrder>(
    "POST",
    "/v2/checkout/orders",
    body,
    { ...ctx, summary: `Create AUTHORIZE order for "${args.title}" (${args.amount.value} ${args.amount.currency_code})` },
    () => ({ id: mockId("MOCK-ORDER"), status: "CREATED", intent: "AUTHORIZE" }),
  );
}

export function authorizeOrder(orderId: string, amount: Money, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<PayPalOrder>(
    "POST",
    `/v2/checkout/orders/${orderId}/authorize`,
    {},
    { ...ctx, summary: `Authorize order ${orderId} — funds held in escrow` },
    () => {
      const now = new Date();
      return {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              authorizations: [
                {
                  id: mockId("MOCK-AUTH"),
                  status: "CREATED",
                  amount,
                  create_time: now.toISOString(),
                  expiration_time: new Date(now.getTime() + 29 * 86400_000).toISOString(),
                },
              ],
            },
          },
        ],
      };
    },
  );
}

export function getOrder(orderId: string, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<PayPalOrder>("GET", `/v2/checkout/orders/${orderId}`, undefined, { ...ctx, summary: `Get order ${orderId}` }, () => ({
    id: orderId,
    status: "APPROVED",
  }));
}
