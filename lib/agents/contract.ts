import * as z from "zod/v4";
import { structuredCall } from "./llm";
import { CONTRACT_AGENT_SYSTEM } from "./prompts";

export const CheckType = z.enum(["VISUAL", "FUNCTIONAL", "CONTENT", "CODE", "WORD_COUNT"]);

export const ExtractionSchema = z.object({
  title: z.string(),
  summary: z.string(),
  client_name: z.string(),
  freelancer_name: z.string(),
  currency: z.string(),
  milestones: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      amount: z.number(),
      due_date: z.string().nullable(),
      criteria: z.array(
        z.object({
          text: z.string(),
          check_type: CheckType,
          min_words: z.number().nullable(),
        }),
      ),
    }),
  ),
  ambiguities: z.array(z.string()),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Business rules beyond schema shape — violations trigger the repair prompt. */
export function validateExtraction(x: Extraction): string[] {
  const errs: string[] = [];
  if (!x.milestones.length) errs.push("milestones: at least one milestone is required");
  if (!/^[A-Z]{3}$/.test(x.currency)) errs.push(`currency: "${x.currency}" is not an ISO-4217 code`);
  x.milestones.forEach((m, i) => {
    if (!(m.amount > 0)) errs.push(`milestones.${i}.amount must be > 0`);
    if (m.criteria.length < 2 || m.criteria.length > 5) errs.push(`milestones.${i}.criteria must have 2–5 items (has ${m.criteria.length})`);
    if (m.due_date && Number.isNaN(Date.parse(m.due_date))) errs.push(`milestones.${i}.due_date "${m.due_date}" is not YYYY-MM-DD`);
    m.criteria.forEach((c, j) => {
      if (c.check_type === "WORD_COUNT" && !(c.min_words && c.min_words > 0))
        errs.push(`milestones.${i}.criteria.${j}: WORD_COUNT criteria need min_words`);
    });
  });
  return errs;
}

export async function extractContract(thread: string, opts: { contractId?: string } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return structuredCall<Extraction>({
    agent: "contract",
    system: CONTRACT_AGENT_SYSTEM,
    content: `Today's date: ${today}\n\n<thread>\n${thread}\n</thread>`,
    schema: ExtractionSchema,
    validate: validateExtraction,
    effort: "medium",
    ctx: { contractId: opts.contractId, summary: "Contract Agent extracted deal terms from the pasted thread" },
    auditInput: { thread },
    mock: () => mockExtract(thread),
  });
}

/** Deterministic heuristic used only in MOCK mode (no Anthropic key) so the demo still flows. */
function mockExtract(thread: string): Extraction {
  const amounts = Array.from(thread.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)).map((m) => Number(m[1].replace(/,/g, "")));
  const lower = thread.toLowerCase();
  const isBlog = /blog|article|post|copy/.test(lower);
  const isSite = /landing|website|site|page/.test(lower);
  const ms: Extraction["milestones"] = [];
  const amts = amounts.length ? amounts.slice(0, 3) : [500];
  amts.forEach((amount, i) => {
    const criteria: Extraction["milestones"][number]["criteria"] =
      isBlog && !isSite
        ? [
            { text: "Blog post is at least 1200 words", check_type: "WORD_COUNT", min_words: 1200 },
            { text: "Post covers the agreed topic with an intro, 3+ sections and a conclusion", check_type: "CONTENT", min_words: null },
          ]
        : [
            { text: "Landing page has a working contact form (name, email, message)", check_type: "FUNCTIONAL", min_words: null },
            { text: "Layout is mobile responsive at 375px with no horizontal scroll", check_type: "VISUAL", min_words: null },
            { text: "Page includes a hero section with headline and call-to-action button", check_type: "VISUAL", min_words: null },
          ];
    ms.push({ title: i === 0 ? (isSite ? "Landing page build" : "First draft") : `Milestone ${i + 1}`, description: "", amount, due_date: null, criteria });
  });
  return {
    title: isSite ? "Landing page project" : isBlog ? "Content writing project" : "Freelance project",
    summary: "[MOCK extraction — set ANTHROPIC_API_KEY for real AI output] " + thread.slice(0, 140).replace(/\s+/g, " "),
    client_name: "",
    freelancer_name: "",
    currency: "USD",
    milestones: ms,
    ambiguities: amounts.length ? [] : ["No amount found in the thread — defaulted to $500."],
  };
}
