import fs from "fs";
import path from "path";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidChart } from "./MermaidChart";

export const metadata = {
  title: "Help — Chaingammon",
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/`([^`]*)`/g, "$1")  // strip backtick delimiters, keep inner text
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface TocEntry { level: number; text: string; id: string; }

function extractHeadings(md: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const idCount: Record<string, number> = {};
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,3}) (.+)$/);
    if (!m) continue;
    const raw = m[2].trim().replace(/`([^`]*)`/g, "$1");
    const base = slugify(raw);
    const n = idCount[base] ?? 0;
    const id = n === 0 ? base : `${base}-${n}`;
    idCount[base] = n + 1;
    entries.push({ level: m[1].length, text: raw, id });
  }
  return entries;
}

function nodeText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(nodeText).join("");
  if (React.isValidElement(children))
    return nodeText(
      (children as React.ReactElement<{ children?: React.ReactNode }>).props.children
    );
  return "";
}

export default function HelpPage() {
  const readme = fs.readFileSync(
    path.join(process.cwd(), "..", "README.md"),
    "utf-8",
  );
  const toc = extractHeadings(readme);

  // Dedup counter matches extractHeadings traversal order.
  const renderIdCount: Record<string, number> = {};
  function nextId(text: string): string {
    const base = slugify(text);
    const n = renderIdCount[base] ?? 0;
    const id = n === 0 ? base : `${base}-${n}`;
    renderIdCount[base] = n + 1;
    return id;
  }

  /* eslint-disable react/display-name */
  const components = {
    h1: ({ children }: { children?: React.ReactNode }) => (
      <h1 id={nextId(nodeText(children))}>{children}</h1>
    ),
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 id={nextId(nodeText(children))}>{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 id={nextId(nodeText(children))}>{children}</h3>
    ),
    code: ({
      className,
      children,
    }: {
      className?: string;
      children?: React.ReactNode;
    }) => {
      if (className === "language-mermaid") {
        return <MermaidChart code={String(children).trimEnd()} />;
      }
      return <code className={className}>{children}</code>;
    },
  };
  /* eslint-enable react/display-name */

  return (
    <div style={{ background: "var(--cg-bg-0)", minHeight: "100%" }}>
      <div
        style={{
          display: "flex",
          maxWidth: 1160,
          margin: "0 auto",
          padding: "48px 24px 96px",
          gap: 56,
          alignItems: "flex-start",
        }}
      >
        {/* ── TOC sidebar ── */}
        <nav
          aria-label="Table of contents"
          style={{
            width: 220,
            flexShrink: 0,
            position: "sticky",
            top: 72,
            maxHeight: "calc(100vh - 96px)",
            overflowY: "auto",
          }}
        >
          <p
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--cg-fg-4)",
              fontFamily: "var(--cg-font-sans)",
              marginBottom: 10,
            }}
          >
            Contents
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {toc.map((h, i) => (
              <li
                key={i}
                style={{
                  paddingLeft: (h.level - 1) * 14,
                  marginBottom: h.level === 1 ? 6 : 2,
                }}
              >
                <a
                  href={`#${h.id}`}
                  className={`cg-toc-link${h.level === 1 ? " cg-toc-link--h1" : ""}`}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* ── Main prose ── */}
        <article className="cg-prose" style={{ flex: 1, minWidth: 0 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {readme}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
