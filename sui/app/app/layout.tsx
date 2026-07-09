import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import "./globals.css";

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
  title: "Chaingammon (Sui, unrated)",
  description: "Standalone Sui-native Chaingammon: unrated peer-to-peer backgammon",
};

// Ensures mobile browsers render at device width instead of zooming out
// to a desktop-width viewport.
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
      <body className="h-full flex flex-col overflow-x-hidden overflow-y-auto">
        <div className="flex flex-1 flex-col min-w-0">
          <header
            style={{
              background: "rgba(21,17,14,0.88)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              borderBottom: "1px solid var(--cg-line-1)",
              position: "sticky",
              top: 0,
              zIndex: 40,
            }}
            className="flex items-center justify-between gap-4 px-4 md:px-6 py-3"
          >
            <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="Chaingammon home">
              <span
                style={{
                  fontFamily: "var(--cg-font-display)",
                  fontSize: "17px",
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
            <span style={{ color: "var(--cg-fg-4)", fontSize: "12px" }}>Sui · unrated</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
