import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import "./globals.css";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { currentUser } from "@/lib/session";
import { isMockMode } from "@/lib/mode";

const geistSans = localFont({ src: "./fonts/GeistVF.woff", variable: "--font-geist-sans", weight: "100 900" });
const geistMono = localFont({ src: "./fonts/GeistMonoVF.woff", variable: "--font-geist-mono", weight: "100 900" });

export const metadata: Metadata = {
  title: "Settle — AI escrow for freelance work",
  description: "Turn a chat thread into an escrowed, AI-verified contract on PayPal.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { role, user } = await currentUser().catch(() => ({ role: "CLIENT" as const, user: null }));
  const mock = isMockMode();
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-slate-50 font-sans text-slate-900 antialiased`}>
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-[#003087] text-sm text-white">S</span>
              Settle
            </Link>
            <nav className="flex gap-4 text-sm text-slate-600">
              <Link href="/" className="hover:text-slate-900">My contracts</Link>
              <Link href="/contracts/new" className="hover:text-slate-900">New from chat</Link>
              <Link href="/dashboard" className="hover:text-slate-900">Ops dashboard</Link>
              <Link href="/assistant" className="hover:text-slate-900">Assistant</Link>
            </nav>
            <div className="ml-auto flex items-center gap-3">
              {mock && (
                <span className="rounded bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800" title="PayPal/Anthropic credentials missing — calls are simulated and labelled MOCK in the audit trail">
                  MOCK MODE
                </span>
              )}
              <span className="hidden text-xs text-slate-500 sm:inline">{user ? `${user.name} · ${user.paypalEmail}` : "no seed data"}</span>
              <RoleSwitcher role={role} />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
