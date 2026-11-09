import { chromium, type Browser, type Page } from "playwright";
import dns from "dns/promises";
import net from "net";

/**
 * Evidence collector for URL deliveries. Loads the page headless at desktop and 375px widths,
 * takes screenshots, and extracts facts in CODE (overflow width, forms, word count, console errors)
 * so the LLM judges criteria from measured evidence rather than guessing.
 */

export type ViewportEvidence = {
  label: "desktop" | "mobile";
  width: number;
  screenshot: Buffer; // JPEG
  scrollWidth: number;
  horizontalOverflow: boolean;
};

export type PageEvidence = {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  loadMs: number;
  title: string;
  metaViewport: string | null;
  text: string;
  wordCount: number;
  headings: string[];
  forms: { action: string | null; method: string | null; fields: { tag: string; type: string | null; name: string | null; label: string | null; required: boolean }[]; submit: string | null }[];
  buttons: string[];
  links: { internal: number; external: number; sample: { text: string; href: string }[] };
  imagesMissingAlt: number;
  consoleErrors: string[];
  viewports: ViewportEvidence[];
  /** "browser" = Playwright screenshots + live DOM; "text-only" = fallback from raw HTML (no screenshots). */
  mode: "browser" | "text-only";
  /** Why the browser path was skipped (text-only mode). */
  fallbackReason?: string;
  /** Lightweight CSS hints for responsiveness when no screenshot exists. */
  responsiveHints?: { mediaQueries: number; maxWidthBreakpoints: number[] };
};

/** Blocks SSRF: only public http(s) hosts. */
export async function assertPublicUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) URLs can be verified");
  const host = u.hostname;
  // The app's own public host (APP_URL, e.g. https://settle-wuro.onrender.com) is always allowed, so the
  // built-in /demo-delivery page can be verified. It still goes through the private-IP check below.
  // For LOCAL dev only, VERIFIER_ALLOW_SELF=1 also lets a localhost APP_URL through. Never set it in production.
  const self = selfHost();
  if (self && host === self && process.env.VERIFIER_ALLOW_SELF === "1") return u;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private hosts are not allowed");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const a of addrs) {
    if (isPrivate(a)) throw new Error(`Host resolves to a private address (${a})`);
  }
  return u;
}

function selfHost() {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null;
  } catch {
    return null;
  }
}

function isPrivate(ip: string) {
  if (net.isIPv6(ip)) return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80") || ip.startsWith("::ffff:127.");
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Low-memory Chromium for a 512 MB instance: a fresh browser per verification (nothing reused between
 * runs), always closed in `finally`, and at most ONE browser at a time (in-process lock).
 */
const CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--disable-extensions"];

let lock: Promise<unknown> = Promise.resolve();
function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

const MAX_SHOT_HEIGHT = 3000;
const NAV_TIMEOUT = 15_000;

async function shoot(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 900);
  const vp = page.viewportSize()!;
  return page.screenshot({
    type: "jpeg",
    quality: 60,
    fullPage: true,
    clip: { x: 0, y: 0, width: vp.width, height: Math.min(Math.max(h, vp.height), MAX_SHOT_HEIGHT) },
  });
}

/**
 * Collects evidence for a URL delivery. Tries the headless browser first; if Chromium can't launch,
 * crashes or runs out of memory, falls back to a text-only collector over the raw HTML.
 */
export async function collectPageEvidence(rawUrl: string): Promise<PageEvidence> {
  const url = (await assertPublicUrl(rawUrl)).toString();
  if (process.env.VERIFIER_FORCE_TEXT_ONLY === "1") return collectTextOnly(url, "VERIFIER_FORCE_TEXT_ONLY=1");
  try {
    return await withBrowserLock(() => collectWithBrowser(url));
  } catch (e) {
    const reason = (e as Error).message.split("\n")[0].slice(0, 200);
    console.warn(`[verifier] browser collection failed, falling back to text-only: ${reason}`);
    return collectTextOnly(url, reason);
  }
}

async function collectWithBrowser(url: string): Promise<PageEvidence> {
  const browser: Browser = await chromium.launch({ args: CHROMIUM_ARGS, timeout: 30_000 });
  const consoleErrors: string[] = [];
  const viewports: ViewportEvidence[] = [];
  let ev: Omit<PageEvidence, "viewports" | "consoleErrors" | "mode"> | null = null;
  try {
    for (const vp of [
      { label: "desktop" as const, width: 1366, height: 900, isMobile: false },
      { label: "mobile" as const, width: 375, height: 812, isMobile: true },
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.isMobile,
        userAgent: vp.isMobile
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 SettleVerifier/1.0"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 SettleVerifier/1.0",
      });
      // Some bundlers (esbuild keepNames) inject a __name() helper into functions passed to page.evaluate.
      await ctx.addInitScript({ content: "window.__name = window.__name || ((f) => f);" });
      const page = await ctx.newPage();
      if (vp.label === "desktop") {
        page.on("console", (m) => {
          if (m.type() === "error" && consoleErrors.length < 10) consoleErrors.push(m.text().slice(0, 300));
        });
        page.on("pageerror", (e) => consoleErrors.length < 10 && consoleErrors.push(String(e.message).slice(0, 300)));
      }
      try {
        const t0 = Date.now();
        let resp = await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT }).catch(() => null);
        if (!resp) resp = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
        const loadMs = Date.now() - t0;
        await page.waitForTimeout(500);

        const overflow = await page.evaluate(() => ({
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
          clientWidth: document.documentElement.clientWidth,
        }));
        viewports.push({
          label: vp.label,
          width: vp.width,
          screenshot: await shoot(page),
          scrollWidth: overflow.scrollWidth,
          horizontalOverflow: overflow.scrollWidth > overflow.clientWidth + 2,
        });

        if (vp.label === "desktop") {
          const dom = await page.evaluate(() => {
            const txt = (document.body?.innerText ?? "").replace(/\s+\n/g, "\n").trim();
            const labelFor = (el: Element) => {
              const id = el.getAttribute("id");
              const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
              return (l?.textContent ?? el.getAttribute("placeholder") ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 60) || null;
            };
            const host = location.host;
            const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
            return {
              title: document.title,
              metaViewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
              text: txt,
              headings: Array.from(document.querySelectorAll("h1,h2,h3"))
                .map((h) => `${h.tagName}: ${(h.textContent ?? "").trim().slice(0, 100)}`)
                .slice(0, 30),
              forms: Array.from(document.querySelectorAll("form")).slice(0, 5).map((f) => ({
                action: f.getAttribute("action"),
                method: f.getAttribute("method"),
                fields: Array.from(f.querySelectorAll("input,textarea,select"))
                  .filter((i) => (i as HTMLInputElement).type !== "hidden")
                  .slice(0, 15)
                  .map((i) => ({
                    tag: i.tagName.toLowerCase(),
                    type: i.getAttribute("type"),
                    name: i.getAttribute("name"),
                    label: labelFor(i),
                    required: (i as HTMLInputElement).required,
                  })),
                submit: (f.querySelector('button[type="submit"],input[type="submit"],button:not([type])')?.textContent ?? null)?.trim() || null,
              })),
              buttons: Array.from(document.querySelectorAll("button,a.button,a.btn,[role=button]"))
                .map((b) => (b.textContent ?? "").trim().slice(0, 50))
                .filter(Boolean)
                .slice(0, 20),
              links: {
                internal: anchors.filter((a) => a.host === host).length,
                external: anchors.filter((a) => a.host !== host).length,
                sample: anchors.slice(0, 15).map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 40), href: a.href })),
              },
              imagesMissingAlt: Array.from(document.querySelectorAll("img")).filter((i) => !i.getAttribute("alt")).length,
            };
          });
          ev = {
            url,
            finalUrl: page.url(),
            httpStatus: resp?.status() ?? null,
            loadMs,
            ...dom,
            text: dom.text.slice(0, 12_000),
            wordCount: countWords(dom.text),
          };
        }
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  if (!ev) throw new Error("Could not load the page");
  return { ...(ev as Omit<PageEvidence, "viewports" | "consoleErrors" | "mode">), consoleErrors, viewports, mode: "browser" };
}

// ---------------------------------------------------------------------------------------------
// Text-only fallback: fetch raw HTML (with timeout) and extract facts with a lightweight parser.
// ---------------------------------------------------------------------------------------------

const decode = (t: string) =>
  t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const stripTags = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

export async function collectTextOnly(url: string, fallbackReason = "browser unavailable"): Promise<PageEvidence> {
  const t0 = Date.now();
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "Mozilla/5.0 SettleVerifier/1.0 (text-only)", Accept: "text/html,*/*" },
  });
  // Re-check the final URL after redirects (SSRF).
  const finalUrl = res.url || url;
  if (finalUrl !== url) await assertPublicUrl(finalUrl);
  const html = (await res.text()).slice(0, 2_000_000);
  const loadMs = Date.now() - t0;

  const styles = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => m[1]).join("\n");
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = stripTags(body.replace(/<\/(p|div|h[1-6]|li|section|article|br|tr)>/gi, "\n"));

  const labels = new Map<string, string>();
  for (const m of Array.from(body.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>/gi))) {
    const forId = attr(m[1], "for");
    if (forId) labels.set(forId, stripTags(m[2]).slice(0, 60));
  }
  const forms = Array.from(body.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/gi))
    .slice(0, 5)
    .map((m) => {
      const inner = m[2];
      const fields = Array.from(inner.matchAll(/<(input|textarea|select)\b([^>]*)>/gi))
        .filter((f) => (attr(f[2], "type") ?? "").toLowerCase() !== "hidden")
        .slice(0, 15)
        .map((f) => {
          const id = attr(f[2], "id");
          return {
            tag: f[1].toLowerCase(),
            type: attr(f[2], "type"),
            name: attr(f[2], "name"),
            label: (id && labels.get(id)) || attr(f[2], "placeholder") || attr(f[2], "aria-label"),
            required: /\brequired\b/i.test(f[2]),
          };
        });
      const submitBtn = inner.match(/<button(?![^>]*type\s*=\s*["']?(?:button|reset))[^>]*>([\s\S]*?)<\/button>/i);
      const submitInput = inner.match(/<input\b[^>]*type\s*=\s*["']?submit[^>]*>/i);
      const submit = submitBtn ? stripTags(submitBtn[1]) || null : submitInput ? attr(submitInput[0], "value") || "Submit" : null;
      return { action: attr(m[1], "action"), method: attr(m[1], "method"), fields: fields.filter((f) => f.type?.toLowerCase() !== "submit"), submit };
    });

  const host = new URL(finalUrl).host;
  const anchors = Array.from(body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map((m) => {
    const href = attr(m[1], "href") ?? "";
    let abs = href;
    try {
      abs = new URL(href, finalUrl).toString();
    } catch {}
    return { text: stripTags(m[2]).slice(0, 40), href: abs, cls: attr(m[1], "class") ?? "" };
  });
  const isInternal = (h: string) => {
    try {
      return new URL(h).host === host;
    } catch {
      return true;
    }
  };

  const breakpoints = Array.from(styles.matchAll(/@media[^{]*max-width\s*:\s*(\d+)px/gi)).map((m) => Number(m[1]));
  return {
    url,
    finalUrl,
    httpStatus: res.status,
    loadMs,
    title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    metaViewport: attr(html.match(/<meta[^>]+name\s*=\s*["']?viewport[^>]*>/i)?.[0] ?? "", "content"),
    text: text.slice(0, 12_000),
    wordCount: countWords(text),
    headings: Array.from(body.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi))
      .map((m) => `${m[1].toUpperCase()}: ${stripTags(m[2]).slice(0, 100)}`)
      .slice(0, 30),
    forms,
    buttons: [
      ...Array.from(body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)).map((m) => stripTags(m[1])),
      ...anchors.filter((a) => /\b(btn|button|cta)\b/i.test(a.cls)).map((a) => a.text),
    ]
      .filter(Boolean)
      .slice(0, 20),
    links: {
      internal: anchors.filter((a) => isInternal(a.href)).length,
      external: anchors.filter((a) => !isInternal(a.href)).length,
      sample: anchors.slice(0, 15).map(({ text, href }) => ({ text, href })),
    },
    imagesMissingAlt: Array.from(body.matchAll(/<img\b([^>]*)>/gi)).filter((m) => !attr(m[1], "alt")).length,
    consoleErrors: [],
    viewports: [],
    mode: "text-only",
    fallbackReason,
    responsiveHints: { mediaQueries: (styles.match(/@media/gi) ?? []).length, maxWidthBreakpoints: breakpoints },
  };
}

export function countWords(text: string) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
