// Phase 28: root layout updated to include global sidebar.
// The sidebar (client component) appears on every page via the flex
// wrapper inside <Providers>. Both the sidebar and page content share
// the wagmi + react-query context provided by <Providers>.
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Sidebar } from "./Sidebar";

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
            <div className="flex flex-1 flex-col min-w-0">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
