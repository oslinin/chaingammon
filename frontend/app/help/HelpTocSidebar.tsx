"use client";

import { useState } from "react";

export interface TocEntry { level: number; text: string; id: string; }

export function HelpTocSidebar({ toc }: { toc: TocEntry[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <nav
      aria-label="Table of contents"
      style={{
        width: expanded ? 340 : 220,
        flexShrink: 0,
        position: "sticky",
        top: 72,
        maxHeight: "calc(100vh - 96px)",
        overflowY: "auto",
        transition: "width 180ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <p
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--cg-fg-4)",
            fontFamily: "var(--cg-font-sans)",
            margin: 0,
          }}
        >
          Contents
        </p>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--cg-fg-4)",
            fontSize: 14,
            padding: "0 2px",
            lineHeight: 1,
            transition: "color 120ms",
          }}
        >
          {expanded ? "←" : "→"}
        </button>
      </div>

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
  );
}
