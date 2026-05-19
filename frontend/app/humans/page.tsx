// /humans — server entry. Client UI lives in HumanClient.
// Uses query parameters (?id=) to support static export without 404s.

import HumanClient from "./HumanClient";

export default function HumanInfoPage() {
  return <HumanClient />;
}
