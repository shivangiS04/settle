export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SETTLE_DISABLE_TICK === "1") return;
  const { tick } = await import("./lib/tick");
  const run = () => tick().catch((e) => console.error("[tick]", e));
  setTimeout(run, 10_000);
  setInterval(run, 60_000);
}
