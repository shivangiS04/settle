/**
 * One-shot PayPal sandbox setup:
 *   npm run paypal:setup -- https://your-public-url        (Render URL or ngrok URL)
 *
 * 1. Verifies PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET by fetching an OAuth token.
 * 2. Checks that ANTHROPIC_API_KEY works (if set).
 * 3. Creates (or reuses) a webhook at <url>/api/webhooks/paypal with all events Settle handles.
 * 4. Writes PAYPAL_WEBHOOK_ID, NEXT_PUBLIC_PAYPAL_CLIENT_ID and APP_URL into .env.
 */
import fs from "node:fs";

try {
  process.loadEnvFile(".env");
} catch {}

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const EVENTS = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
];

function setEnv(key: string, value: string) {
  let s = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const line = `${key}="${value}"`;
  s = new RegExp(`^${key}=.*$`, "m").test(s) ? s.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${s.trimEnd()}\n${line}\n`;
  fs.writeFileSync(".env", s);
}

async function main() {
  const url = process.argv[2]?.replace(/\/$/, "");
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Put PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");

  // 1. OAuth
  const tok = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tok.ok) throw new Error(`PayPal OAuth failed (${tok.status}): ${await tok.text()}\n→ Check the client id/secret are the SANDBOX ones.`);
  const { access_token, scope } = (await tok.json()) as { access_token: string; scope: string };
  console.log("✅ PayPal sandbox credentials work");
  const has = (s: string) => scope.includes(s);
  console.log(`   Payouts scope:   ${has("payments/payouts") ? "✅" : "⚠️  missing — enable Payouts on the sandbox app"}`);
  console.log(`   Invoicing scope: ${has("invoicing") ? "✅" : "⚠️  missing — enable Invoicing on the sandbox app"}`);
  setEnv("NEXT_PUBLIC_PAYPAL_CLIENT_ID", id);

  // 2. Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    console.log(r.ok ? "✅ Anthropic API key works" : `❌ Anthropic API key rejected (${r.status})`);
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
    console.log(r.ok ? `✅ Gemini API key works (${model})` : `❌ Gemini key/model rejected (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    console.log("⚠️  No ANTHROPIC_API_KEY or GEMINI_API_KEY — agents will run in MOCK mode");
  }

  // 3. Webhook
  if (!url) {
    console.log("\nℹ️  No public URL given — skipping webhook. Re-run with: npm run paypal:setup -- https://<your-url>");
    return;
  }
  if (!url.startsWith("https://")) throw new Error("PayPal webhooks need an https:// URL (Render or ngrok).");
  const target = `${url}/api/webhooks/paypal`;
  const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
  const list = (await (await fetch(`${BASE}/v1/notifications/webhooks`, { headers: auth })).json()) as { webhooks?: { id: string; url: string }[] };
  let hook = list.webhooks?.find((w) => w.url === target);
  if (!hook) {
    const r = await fetch(`${BASE}/v1/notifications/webhooks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: target, event_types: EVENTS.map((name) => ({ name })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Webhook create failed (${r.status}): ${JSON.stringify(j)}`);
    hook = j as { id: string; url: string };
    console.log(`✅ Created webhook ${hook.id} → ${target}`);
  } else {
    console.log(`✅ Webhook already exists ${hook.id} → ${target}`);
  }
  setEnv("PAYPAL_WEBHOOK_ID", hook.id);
  setEnv("APP_URL", url);
  console.log(`\n.env updated: PAYPAL_WEBHOOK_ID=${hook.id}, NEXT_PUBLIC_PAYPAL_CLIENT_ID, APP_URL=${url}`);
  console.log("Restart the app (npm run build && npm start) to pick up the new values.");
}

main().catch((e) => {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
});
