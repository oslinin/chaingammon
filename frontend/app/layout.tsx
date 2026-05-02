// Phase 28: root layout updated to include global sidebar.
// Phase 35: responsive layout — viewport meta tag, sidebar hidden on mobile,
// MobileNav fixed bottom bar for small screens.
// Phase 57: consolidated single top navbar — network, address, and compute
// backends all live in the global bar so per-page headers are no longer needed.
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
              {/* Single global top navbar: brand, compute backends (local/0G
                  per-operation toggles), and wallet connect/network/address. */}
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
                <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                  Chaingammon
                </span>
                <div className="flex flex-wrap items-center gap-3">
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
