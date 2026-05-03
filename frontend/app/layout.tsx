// Phase 28: root layout updated to include global sidebar.
// Phase 35: responsive layout — viewport meta tag, sidebar hidden on mobile,
// MobileNav fixed bottom bar for small screens.
// Phase 57: consolidated top navbar — brand, compute-backends, and wallet
// connect (with ELO + match count from ENS) in a single global header.
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ComputeBackendsPill } from "./ComputeBackendsPill";
import { ConnectButton } from "./ConnectButton";
import { Providers } from "./providers";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chaingammon",
  description: "Open backgammon protocol with portable on-chain reputation",
};

// Ensures mobile browsers render at device width instead of zooming out
// to a desktop-width viewport. Without this meta tag the page appears
// tiny on phones because browsers default to ~980px virtual width.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <div className="flex flex-1">
            <Sidebar />
            {/* pb-16 md:pb-0 reserves space for the fixed mobile bottom nav */}
            <div className="flex flex-1 flex-col min-w-0 pb-16 md:pb-0">
              {/* Global top navbar: brand on the left, compute backends
                  + wallet connect (ELO, matches played) on the right.
                  Visible on every page so users always see their stats. */}
              <header className="flex items-center justify-between gap-4 border-b border-indigo-100 px-4 py-2 dark:border-indigo-950/50">
                <a
                  href="/"
                  className="flex items-center gap-2"
                  aria-label="Chaingammon home"
                >
                  <img
                    src="/chaingammon-icon.svg"
                    alt=""
                    width={24}
                    height={24}
                    className="shrink-0"
                  />
                  <span className="text-sm font-semibold tracking-tight text-indigo-700 dark:text-indigo-300">
                    Chaingammon
                  </span>
                </a>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <ComputeBackendsPill />
                  <ConnectButton />
                </div>
              </header>
              {children}
            </div>
          </div>
          <MobileNav />
        </Providers>
      </body>
    </html>
  );
}
