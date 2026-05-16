"use client";

import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";

let _initialized = false;

export function MermaidChart({ code }: { code: string }) {
  const uid = useId().replace(/:/g, "");
  const id = `mermaid-${uid}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!_initialized) {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        darkMode: true,
        themeVariables: {
          background: "transparent",
          primaryColor: "#5C3A1E",
          primaryTextColor: "#D4B896",
          lineColor: "#8B6E52",
          edgeLabelBackground: "#2D1A18",
          tertiaryColor: "#2D1A18",
        },
      });
      _initialized = true;
    }
    mermaid
      .render(id, code)
      .then(({ svg: rendered }) => setSvg(rendered))
      .catch((e: unknown) => setErr(String(e)));
  }, [id, code]);

  if (err) {
    return (
      <pre style={{ color: "var(--cg-fg-3)", fontSize: 12 }}>
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return (
      <div
        style={{
          height: 120,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          color: "var(--cg-fg-4)",
        }}
      >
        rendering…
      </div>
    );
  }
  return (
    <div
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{ overflowX: "auto", margin: "20px 0" }}
    />
  );
}
