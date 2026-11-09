import { cookies } from "next/headers";
import { prisma } from "./db";

/**
 * Demo-grade "auth": a cookie picks which seeded user you are viewing as.
 * The header's "View as Client / Freelancer" switcher sets it.
 */
export type Role = "CLIENT" | "FREELANCER";

export function currentRole(): Role {
  const r = cookies().get("settle_role")?.value;
  return r === "FREELANCER" ? "FREELANCER" : "CLIENT";
}

export async function currentUser() {
  const role = currentRole();
  const user = await prisma.user.findFirst({ where: { role }, orderBy: { createdAt: "asc" } });
  return { role, user };
}

export async function requireUser() {
  const { role, user } = await currentUser();
  if (!user) throw new Error("No demo users — run `npm run seed`.");
  return { role, user };
}
