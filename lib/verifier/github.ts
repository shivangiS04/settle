/**
 * Evidence collector for GitHub deliveries: repo metadata, README, file tree and a few key files.
 * Uses GITHUB_TOKEN if set (higher rate limit), otherwise unauthenticated public API.
 */

export type RepoEvidence = {
  repo: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  pushedAt: string | null;
  readme: string | null;
  tree: string[];
  treeTruncated: boolean;
  files: { path: string; content: string }[];
  facts: { fileCount: number; hasTests: boolean; hasLicense: boolean; hasCi: boolean; readmeWords: number };
};

const KEY_FILE_PATTERNS = [
  /^package\.json$/,
  /^requirements\.txt$/,
  /^pyproject\.toml$/,
  /^index\.html$/,
  /^(src\/)?(app|main|index)\.(t|j)sx?$/,
  /^app\/page\.(t|j)sx?$/,
  /^src\/App\.(t|j)sx?$/,
  /^main\.py$/,
  /^Dockerfile$/,
];

export function parseRepo(url: string) {
  const m = url.trim().match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/i);
  if (!m) throw new Error("Not a GitHub repository URL (expected https://github.com/owner/repo)");
  return { owner: m[1], repo: m[2] };
}

async function gh<T>(path: string, raw = false): Promise<T> {
  const headers: Record<string, string> = {
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "User-Agent": "settle-verifier",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers, cache: "no-store" });
  if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}`);
  return (raw ? r.text() : r.json()) as Promise<T>;
}

export async function collectRepoEvidence(url: string): Promise<RepoEvidence> {
  const { owner, repo } = parseRepo(url);
  const meta = await gh<{ full_name: string; description: string | null; default_branch: string; language: string | null; pushed_at: string }>(
    `/repos/${owner}/${repo}`,
  );
  const readme = await gh<string>(`/repos/${owner}/${repo}/readme`, true).catch(() => null);
  const tree = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${meta.default_branch}?recursive=1`,
  );
  const blobs = tree.tree.filter((t) => t.type === "blob" && !t.path.includes("node_modules/"));
  const paths = blobs.map((b) => b.path);

  const keyPaths = paths.filter((p) => KEY_FILE_PATTERNS.some((re) => re.test(p))).slice(0, 6);
  const files: RepoEvidence["files"] = [];
  for (const p of keyPaths) {
    const content = await gh<string>(`/repos/${owner}/${repo}/contents/${encodeURI(p)}?ref=${meta.default_branch}`, true).catch(() => null);
    if (content) files.push({ path: p, content: content.slice(0, 8000) });
  }

  return {
    repo: meta.full_name,
    description: meta.description,
    defaultBranch: meta.default_branch,
    language: meta.language,
    pushedAt: meta.pushed_at,
    readme: readme ? readme.slice(0, 12_000) : null,
    tree: paths.slice(0, 400),
    treeTruncated: tree.truncated || paths.length > 400,
    files,
    facts: {
      fileCount: paths.length,
      hasTests: paths.some((p) => /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.\w+$/.test(p)),
      hasLicense: paths.some((p) => /^licen[cs]e/i.test(p)),
      hasCi: paths.some((p) => p.startsWith(".github/workflows/")),
      readmeWords: readme ? (readme.match(/\S+/g) ?? []).length : 0,
    },
  };
}
