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
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private hosts are not allowed");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const a of addrs) {
    if (isPrivate(a)) throw new Error(`Host resolves to a private address (${a})`);
  }
  return u;
}

function isPrivate(ip: string) {
  if (net.isIPv6(ip)) return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80") || ip.startsWith("::ffff:127.");
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

let browserPromise: Promise<Browser> | null = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

const MAX_SHOT_HEIGHT = 2400;

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

export async function collectPageEvidence(rawUrl: string): Promise<PageEvidence> {
  const url = (await assertPublicUrl(rawUrl)).toString();
  const browser = await getBrowser();
  const consoleErrors: string[] = [];
  const viewports: ViewportEvidence[] = [];
  let ev: Omit<PageEvidence, "viewports" | "consoleErrors"> | null = null;

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
    const page = await ctx.newPage();
    if (vp.label === "desktop") {
      page.on("console", (m) => {
        if (m.type() === "error" && consoleErrors.length < 10) consoleErrors.push(m.text().slice(0, 300));
      });
      page.on("pageerror", (e) => consoleErrors.length < 10 && consoleErrors.push(String(e.message).slice(0, 300)));
    }
    try {
      const t0 = Date.now();
      let resp = await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 }).catch(() => null);
      if (!resp) resp = await page.goto(url, { waitUntil: "load", timeout: 25_000 });
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
      await ctx.close();
    }
  }
  if (!ev) throw new Error("Could not load the page");
  return { ...(ev as Omit<PageEvidence, "viewports" | "consoleErrors">), consoleErrors, viewports };
}

export function countWords(text: string) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
