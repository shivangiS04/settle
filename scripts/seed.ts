/**
 *   npm run seed              # seed only if the DB is empty (safe; used on every container start)
 *   npm run seed -- --reset   # wipe app data and reseed (or SEED_RESET=1)
 * Only the app database is touched — never PayPal.
 */
try {
  process.loadEnvFile(".env"); // local dev; on Render env vars come from the dashboard
} catch {}

async function main() {
  const { resetAndSeed, seedIfEmpty } = await import("../lib/seed");
  const { prisma } = await import("../lib/db");
  const reset = process.argv.includes("--reset") || process.env.SEED_RESET === "1";
  try {
    if (reset) {
      const r = await resetAndSeed();
      console.log(`Reset + seeded: ${r.contracts} contracts, ${r.milestones} milestones, ${r.auditEvents} audit events (users: ${r.users.join(", ")})`);
    } else {
      const r = await seedIfEmpty();
      console.log(r.seeded ? `Seeded empty database: ${r.contracts} contracts, users: ${r.users.join(", ")}` : `Database already has data (${r.users} users, ${r.contracts} contracts) — not seeding. Use --reset to wipe and reseed.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
