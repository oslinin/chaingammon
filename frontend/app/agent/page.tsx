// /agent — server entry. Client UI lives in AgentClient.
// Uses query parameters (?id=) to support static export without 404s.

import AgentClient from "./AgentClient";

export default function AgentInfoPage() {
  return <AgentClient />;
}
