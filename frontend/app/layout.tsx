// Phase 28: root layout updated to include global sidebar.
// Phase 35: responsive layout — viewport meta tag, sidebar hidden on mobile,
// MobileNav fixed bottom bar for small screens.
// Phase 57: consolidated top navbar — brand, compute-backends, and wallet
// connect (with ELO + match count from ENS) in a single global header.
import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ComputeBackendsPill } from "./ComputeBackendsPill";
import { ConnectButton } from "./ConnectButton";
import { Providers } from "./providers";
import { MobileNav } from "./MobileNav";

const cgSans = Space_Grotesk({
  variable: "--font-cg-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const cgMono = JetBrains_Mono({
  variable: "--font-cg-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const cgDisplay = Instrument_Serif({
  variable: "--font-cg-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
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
      className={`${cgSans.variable} ${cgMono.variable} ${cgDisplay.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col overflow-x-hidden">
        <Providers>
          <div className="flex flex-1">
            {/* pb-16 reserves space for the fixed mobile bottom nav */}
            <div className="flex flex-1 flex-col min-w-0 pb-16 md:pb-0">
              {/* Global top navbar: brand on the left, compute backends
                  + wallet connect (ELO, matches played) on the right. */}
              <header
                style={{
                  background: "var(--cg-bg-1)",
                  borderBottom: "1px solid var(--cg-line-1)",
                }}
                className="flex items-center justify-between gap-4 px-4 py-2"
              >
                <Link
                  href="/"
                  className="flex items-center gap-2"
                  aria-label="Chaingammon home"
                >
                  <img
                    src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chaingammon-icon.svg`}
                    alt=""
                    width={24}
                    height={24}
                    className="shrink-0"
                  />
                  <span
                    style={{
                      fontFamily: "var(--cg-font-display)",
                      fontSize: "16px",
                      lineHeight: 1,
                      letterSpacing: "-0.02em",
                      display: "inline-flex",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: "var(--cg-fg-2)", fontStyle: "italic" }}>Chain</span>
                    <span style={{ color: "var(--cg-brass)", padding: "0 0.05em" }}>·</span>
                    <span style={{ color: "var(--cg-fg-1)" }}>Gammon</span>
                  </span>
                </Link>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <span className="hidden md:block">
                    <ComputeBackendsPill />
                  </span>
                  <Link
                    href="/help"
                    target="_blank"
                    rel="noreferrer"
                    className="cg-nav-link"
                    style={{
                      fontSize: 13,
                      textDecoration: "none",
                      fontFamily: "var(--cg-font-sans)",
                      padding: "4px 8px",
                      borderRadius: "var(--cg-radius-sm)",
                    }}
                  >
                    Help
                  </Link>
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
