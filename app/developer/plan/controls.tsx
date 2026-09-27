"use client";
import { useEffect, useRef, useState } from "react";
import { mountPlanProof } from "../../../web/src/plan-main";
export default function PlanControls() {
  const root = useRef<HTMLFieldSetElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { if (!root.current) return; const release = mountPlanProof(root.current); setReady(true); return release; }, []);
  return <fieldset ref={root} className="proof-controls" disabled={!ready}><button id="prepare">Prepare stereo plan</button><button id="activate" disabled>Activate muted proof</button><button id="invalid">Reject invalid plan version</button><button id="close">Close</button><pre id="result" aria-live="polite">idle</pre></fieldset>;
}
