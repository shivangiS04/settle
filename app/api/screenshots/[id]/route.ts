import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const s = await prisma.screenshot.findUnique({ where: { id: params.id } });
  if (!s) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(s.data), {
    headers: { "Content-Type": s.mime, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
