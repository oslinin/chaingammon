// play-human/[matchId]/page.tsx — static-export entry point.
//
// Next.js 16 with `output: "export"` requires dynamic routes to declare
// their static params at build time. We emit a placeholder shell so the
// route compiles; the real matchId comes from the URL at runtime (the
// client reads it via useParams()).
import PlayHumanClient from "./PlayHumanClient";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ matchId: "placeholder" }];
}

export default function PlayHumanPage() {
  return <PlayHumanClient />;
}
