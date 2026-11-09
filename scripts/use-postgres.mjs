// Swaps the Prisma datasource from SQLite (local dev) to PostgreSQL (Render).
// Run before `prisma generate` in the Docker build. Idempotent.
import fs from "node:fs";
const p = new URL("../prisma/schema.prisma", import.meta.url);
const s = fs.readFileSync(p, "utf8");
const out = s.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
fs.writeFileSync(p, out);
console.log(out === s ? "schema already uses postgresql" : "schema switched to postgresql");
