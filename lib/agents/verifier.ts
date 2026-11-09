import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { prisma } from "../db";
import { audit } from "../audit";
import { structuredCall } from "./llm";
import { VERIFIER_AGENT_SYSTEM } from "./prompts";
import { collectPageEvidence, countWords, type PageEvidence } from "../verifier/browse";
import { collectRepoEvidence, type RepoEvidence } from "../verifier/github";
import { transitionMilestone } from "../state";

export const VerdictSchema = z.object({
  criteria: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      confidence: z.number(),
      evidence: z.string(),
      screenshot: z.enum(["desktop", "mobile"]).nullable(),
    }),
  ),
  summary: z.string(),
});
type Verdict = z.infer<typeof VerdictSchema>;

/** Public result shape: { criteria: [{id, passed, confidence, evidence, screenshot_url?}], score_pct, summary } */
export type VerificationResult = {
  criteria: { id: string; passed: boolean; confidence: number; evidence: string; screenshot_url?: string }[];
  score_pct: number;
  summary: string;
};

type Crit = { id: string; text: string; checkType: string; minWords: number | null };

export async function runVerification(milestoneId: string, deliveryId: string, actor = "agent:verifier") {
  const m = await prisma.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: { criteria: { orderBy: { idx: "asc" } }, contract: true },
  });
  const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
  const crits: Crit[] = m.criteria.map((c) => ({ id: c.id, text: c.text, checkType: c.checkType, minWords: c.minWords }));
  const ctx = { contractId: m.contractId, milestoneId: m.id };

  // 1) Gather evidence with tools (code, not the LLM).
  let page: PageEvidence | null = null;
  let repo: RepoEvidence | null = null;
  let textWords: number | null = null;
  const t0 = Date.now();
  try {
    if (d.type === "URL") page = await collectPageEvidence(d.content);
    else if (d.type === "GITHUB") repo = await collectRepoEvidence(d.content);
    else textWords = countWords(d.content);
  } catch (e) {
    await audit({ ...ctx, actor, kind: "ERROR", action: "verifier.collect", summary: `Could not collect evidence from ${d.type} delivery: ${(e as Error).message}` });
    throw e;
  }
  await audit({
    ...ctx,
    actor,
    kind: "AGENT_DECISION",
    action: `verifier.collect.${d.type.toLowerCase()}`,
    summary: page
      ? page.mode === "text-only"
        ? `Loaded ${page.finalUrl} as TEXT-ONLY (HTTP ${page.httpStatus}, ${page.loadMs}ms; screenshots unavailable: ${page.fallbackReason}): ${page.wordCount} words, ${page.forms.length} form(s)`
        : `Loaded ${page.finalUrl} (HTTP ${page.httpStatus}, ${page.loadMs}ms): ${page.wordCount} words, ${page.forms.length} form(s), mobile overflow=${page.viewports.find((v) => v.label === "mobile")?.horizontalOverflow}`
      : repo
        ? `Read ${repo.repo}: ${repo.facts.fileCount} files, README ${repo.facts.readmeWords} words, tests=${repo.facts.hasTests}`
        : `Text delivery: ${textWords} words (computed in code)`,
    durationMs: Date.now() - t0,
    response: page ? { ...page, viewports: page.viewports.map((v) => ({ label: v.label, width: v.width, scrollWidth: v.scrollWidth, horizontalOverflow: v.horizontalOverflow })), text: page.text.slice(0, 2000) } : repo ? { ...repo, files: repo.files.map((f) => f.path) } : { words: textWords },
  });

  // 2) Ask the LLM to judge each criterion against the evidence.
  const content = buildContent(m, crits, d, page, repo, textWords);
  const { value, model } = await structuredCall<Verdict>({
    agent: "verifier",
    system: VERIFIER_AGENT_SYSTEM,
    content,
    schema: VerdictSchema,
    validate: (v) => {
      const ids = new Set(crits.map((c) => c.id));
      const got = new Set(v.criteria.map((c) => c.id));
      const errs: string[] = [];
      for (const id of Array.from(ids)) if (!got.has(id)) errs.push(`criteria: missing result for id ${id}`);
      for (const id of Array.from(got)) if (!ids.has(id)) errs.push(`criteria: unknown id ${id}`);
      v.criteria.forEach((c, i) => (c.confidence < 0 || c.confidence > 1) && errs.push(`criteria.${i}.confidence must be 0–1`));
      return errs;
    },
    effort: "medium",
    ctx: { ...ctx, summary: `Verifier Agent judged ${crits.length} criteria for "${m.title}"` },
    auditInput: { delivery: { type: d.type, content: d.type === "TEXT" ? d.content.slice(0, 2000) : d.content }, criteria: crits },
    mock: () => mockVerdict(crits, page, repo, textWords),
  });

  // 3) Deterministic overrides: facts computed in code beat the model.
  const words = page?.wordCount ?? textWords ?? repo?.facts.readmeWords ?? null;
  const mobile = page?.viewports.find((v) => v.label === "mobile");
  for (const r of value.criteria) {
    const c = crits.find((x) => x.id === r.id)!;
    if (c.checkType === "WORD_COUNT" && c.minWords && words != null) {
      const passed = words >= c.minWords;
      if (passed !== r.passed) r.evidence = `[Code check overrides model] ${r.evidence}`;
      r.passed = passed;
      r.confidence = 1;
      r.evidence = `Word count computed in code: ${words} (minimum ${c.minWords}). ${r.evidence}`;
    }
    if (mobile && /375|mobile|responsive/i.test(c.text) && mobile.horizontalOverflow && r.passed) {
      r.passed = false;
      r.confidence = Math.max(r.confidence, 0.9);
      r.evidence = `[Code check] At 375px the page is ${mobile.scrollWidth}px wide (horizontal scroll). ${r.evidence}`;
    }
    r.confidence = Math.min(1, Math.max(0, r.confidence));
  }

  // 4) Persist.
  const passedN = value.criteria.filter((c) => c.passed).length;
  const score = crits.length ? Math.round((passedN / crits.length) * 1000) / 10 : 0;
  const verification = await prisma.verification.create({
    data: {
      milestoneId: m.id,
      deliveryId: d.id,
      scorePct: score,
      summary: value.summary,
      model,
      mode: page?.mode ?? "browser",
      rawJson: JSON.stringify(value),
      screenshots: page ? { create: page.viewports.map((v) => ({ label: v.label, data: new Uint8Array(v.screenshot) })) } : undefined,
    },
    include: { screenshots: true },
  });
  const shotUrl = (label: string | null) => {
    const s = verification.screenshots.find((x) => x.label === label);
    return s ? `/api/screenshots/${s.id}` : undefined;
  };
  for (const r of value.criteria) {
    await prisma.criterionResult.create({
      data: {
        verificationId: verification.id,
        criterionId: r.id,
        passed: r.passed,
        confidence: r.confidence,
        evidence: r.evidence,
        screenshotUrl: shotUrl(r.screenshot) ?? null,
      },
    });
  }

  const autoHours = Number(process.env.AUTO_APPROVE_HOURS ?? "48");
  await prisma.milestone.update({
    where: { id: m.id },
    data: {
      verifierScore: score,
      autoApproveAt: score === 100 ? new Date(Date.now() + autoHours * 3600_000) : null,
      riskFlag: score < 60 ? "LOW_SCORE" : m.riskFlag === "LOW_SCORE" ? null : m.riskFlag,
    },
  });
  const fresh = await prisma.milestone.findUniqueOrThrow({ where: { id: m.id } });
  if (fresh.status === "SUBMITTED") {
    await transitionMilestone(m.id, "VERIFIED", actor, `Verifier score ${score}% (${passedN}/${crits.length} criteria)${score === 100 ? ` — auto-approve in ${autoHours}h unless the client acts` : ""}`);
  }

  const result: VerificationResult = {
    criteria: value.criteria.map((r) => ({ id: r.id, passed: r.passed, confidence: r.confidence, evidence: r.evidence, screenshot_url: shotUrl(r.screenshot) })),
    score_pct: score,
    summary: value.summary,
  };
  return result;
}

function buildContent(
  m: { title: string; description: string; contract: { title: string } },
  crits: Crit[],
  d: { type: string; content: string; note: string },
  page: PageEvidence | null,
  repo: RepoEvidence | null,
  textWords: number | null,
): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const header = [
    `Contract: ${m.contract.title}`,
    `Milestone: ${m.title}${m.description ? ` — ${m.description}` : ""}`,
    `Criteria (judge each by id):`,
    ...crits.map((c) => `- id=${c.id} [${c.checkType}${c.minWords ? `, min_words=${c.minWords}` : ""}] ${c.text}`),
    d.note ? `Freelancer's note: ${d.note}` : "",
  ].join("\n");
  blocks.push({ type: "text", text: header });

  if (page) {
    for (const v of page.viewports) {
      blocks.push({ type: "text", text: `${v.label} screenshot (${v.width}px wide; measured page width ${v.scrollWidth}px; horizontal overflow: ${v.horizontalOverflow}):` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: v.screenshot.toString("base64") } });
    }
    if (page.mode === "text-only") {
      blocks.push({
        type: "text",
        text: "NOTE: Screenshots are unavailable on this server, so evidence comes from the page's raw HTML only. For VISUAL or mobile/375px criteria, judge from the HTML/CSS hints (meta viewport, @media breakpoints, layout markup) and LOWER your confidence accordingly. Never claim to have seen a screenshot.",
      });
    }
    const facts = {
      evidence_mode: page.mode,
      responsive_hints: page.responsiveHints ?? null,
      url: page.url,
      final_url: page.finalUrl,
      http_status: page.httpStatus,
      load_ms: page.loadMs,
      title: page.title,
      meta_viewport: page.metaViewport,
      word_count_computed: page.wordCount,
      headings: page.headings,
      forms: page.forms,
      buttons: page.buttons,
      links: page.links,
      images_missing_alt: page.imagesMissingAlt,
      console_errors: page.consoleErrors,
    };
    blocks.push({ type: "text", text: `Measured facts (authoritative):\n${JSON.stringify(facts, null, 1)}\n\n<page_text>\n${page.text}\n</page_text>` });
  } else if (repo) {
    blocks.push({
      type: "text",
      text: [
        `Repository: ${repo.repo} (branch ${repo.defaultBranch}, language ${repo.language}, last push ${repo.pushedAt})`,
        `Facts (authoritative): ${JSON.stringify(repo.facts)}`,
        `<file_tree truncated="${repo.treeTruncated}">\n${repo.tree.join("\n")}\n</file_tree>`,
        `<readme>\n${repo.readme ?? "(no README)"}\n</readme>`,
        ...repo.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`),
      ].join("\n\n"),
    });
  } else {
    blocks.push({ type: "text", text: `Facts (authoritative): word_count_computed=${textWords}\n\n<delivered_text>\n${d.content}\n</delivered_text>` });
  }
  return blocks;
}

/** MOCK-mode heuristic over the REAL collected evidence (only used without an Anthropic key). */
function mockVerdict(crits: Crit[], page: PageEvidence | null, repo: RepoEvidence | null, textWords: number | null): Verdict {
  const text = (page?.text ?? repo?.readme ?? "").toLowerCase();
  return {
    criteria: crits.map((c) => {
      const t = c.text.toLowerCase();
      let passed = true;
      let evidence = "Heuristic check (MOCK mode).";
      if (/form/.test(t) && page) {
        const f = page.forms.find((f) => f.fields.some((x) => x.type === "email" || /mail/i.test(x.name ?? "")));
        passed = !!f;
        evidence = f ? `Form with ${f.fields.length} fields incl. email found.` : `No form with an email field found (${page.forms.length} forms).`;
      } else if (/375|mobile|responsive/.test(t) && page) {
        const mv = page.viewports.find((v) => v.label === "mobile");
        passed = (mv ? !mv.horizontalOverflow : (page.responsiveHints?.mediaQueries ?? 0) > 0) && !!page.metaViewport;
        evidence = mv
          ? `Mobile width ${mv.scrollWidth}px; meta viewport ${page.metaViewport ? "present" : "missing"}.`
          : `Text-only: ${page.responsiveHints?.mediaQueries ?? 0} @media rule(s); meta viewport ${page.metaViewport ? "present" : "missing"}.`;
      } else if (/hero|call.to.action|\bcta\b|button/.test(t) && page) {
        const h1 = page.headings.find((h) => h.startsWith("H1"));
        passed = !!h1 && page.buttons.length > 0;
        evidence = `${h1 ? `Headline "${h1.slice(4, 60)}"` : "No H1 headline"}; ${page.buttons.length} button(s)${page.buttons[0] ? ` e.g. "${page.buttons[0]}"` : ""}.`;
      } else if (c.checkType === "WORD_COUNT") {
        evidence = `Words: ${page?.wordCount ?? textWords}.`;
      } else if (c.checkType === "CODE" && repo) {
        passed = repo.facts.fileCount > 0;
        evidence = `${repo.facts.fileCount} files; tests=${repo.facts.hasTests}.`;
      } else {
        const kw = t.split(/\W+/).filter((w) => w.length > 4);
        const hits = kw.filter((w) => text.includes(w));
        passed = kw.length === 0 || hits.length / kw.length >= 0.4;
        evidence = `Keyword overlap ${hits.length}/${kw.length}.`;
      }
      return { id: c.id, passed, confidence: 0.5, evidence, screenshot: page && page.viewports.length ? (/375|mobile/.test(t) ? "mobile" : "desktop") : null };
    }),
    summary: "[MOCK] Heuristic verification over real collected evidence. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) for real AI judgment.",
  };
}

const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 90_000);

/**
 * Runs a verification with a hard timeout. On timeout or failure, the error is recorded on the delivery
 * (shown in the UI with a Retry button) and audited — the request never hangs silently.
 */
export async function verifyDelivery(milestoneId: string, deliveryId: string) {
  await prisma.delivery.update({ where: { id: deliveryId }, data: { verifyError: null } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runVerification(milestoneId, deliveryId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Verification timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`)), VERIFY_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    const msg = (e as { userMessage?: string }).userMessage ?? (e as Error).message;
    await prisma.delivery.update({ where: { id: deliveryId }, data: { verifyError: msg.slice(0, 500) } }).catch(() => undefined);
    const m = await prisma.milestone.findUnique({ where: { id: milestoneId } });
    await audit({ contractId: m?.contractId, milestoneId, actor: "agent:verifier", kind: "ERROR", action: "verifier.failed", summary: `Verification failed: ${msg.slice(0, 300)}` });
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
