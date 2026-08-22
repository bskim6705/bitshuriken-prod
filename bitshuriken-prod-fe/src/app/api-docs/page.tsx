import { ScalarReference } from "./scalar-reference";

// REST API reference. Scalar owns the full content region: its sidebar (with the
// Spot/Futures/Portal source dropdown) stays pinned and the content scrolls
// internally. The docs shell (layout.tsx) provides the top bar.
export default function ApiReferencePage() {
  return <ScalarReference />;
}
