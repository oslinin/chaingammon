import fs from "fs";
import path from "path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const metadata = {
  title: "Help — Chaingammon",
};

export default function HelpPage() {
  const readme = fs.readFileSync(
    path.join(process.cwd(), "..", "README.md"),
    "utf-8",
  );

  return (
    <div
      style={{
        background: "var(--cg-bg-0)",
        minHeight: "100%",
        padding: "48px 24px 96px",
      }}
    >
      <article
        className="cg-prose mx-auto"
        style={{ maxWidth: 800 }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {readme}
        </ReactMarkdown>
      </article>
    </div>
  );
}
