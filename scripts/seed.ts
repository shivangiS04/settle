import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const client = await prisma.user.upsert({
    where: { email: "maya@client.demo" },
    update: { paypalEmail: process.env.DEMO_CLIENT_PAYPAL_EMAIL || "client-buyer@personal.example.com" },
    create: { name: "Maya Chen", email: "maya@client.demo", role: "CLIENT", paypalEmail: process.env.DEMO_CLIENT_PAYPAL_EMAIL || "client-buyer@personal.example.com" },
  });
  const freelancer = await prisma.user.upsert({
    where: { email: "dev@freelancer.demo" },
    update: { paypalEmail: process.env.DEMO_FREELANCER_PAYPAL_EMAIL || "freelancer@personal.example.com" },
    create: { name: "Arjun Rao", email: "dev@freelancer.demo", role: "FREELANCER", paypalEmail: process.env.DEMO_FREELANCER_PAYPAL_EMAIL || "freelancer@personal.example.com" },
  });
  console.log("users", client.id, freelancer.id);
}
main().finally(() => prisma.$disconnect());
