type Observation = {
  analysing: boolean;
  snapshot: { renderFrame: number };
  signalPeak: number;
};

export type RenderingOverlap =
  | { status: "observed" }
  | { status: "inconclusive"; reason: "analysis-completed-before-observation" };

// Await each poll before starting another. Keep the original seek deadline even
// when analysis completes early, and never count a sample collected afterward.
export async function sampleRenderingOverlap(
  analysis: Promise<unknown>,
  initialRenderFrame: number,
  sample: (phase: "analysis" | "before-seek") => Promise<Observation>,
  wait: (ms: number) => Promise<unknown>,
): Promise<RenderingOverlap> {
  const seekAt = performance.now() + 150;
  let pending = true;
  let failure: { cause: unknown } | undefined;
  void analysis.then(() => { pending = false; }, cause => { pending = false; failure = { cause }; });
  const checkFailure = () => { if (failure) throw failure.cause; };
  let observed = false;
  const observe = async (phase: "analysis" | "before-seek") => {
    const row = await sample(phase);
    checkFailure();
    if (row.analysing && row.snapshot.renderFrame > initialRenderFrame && row.signalPeak > 0) observed = true;
  };
  while (pending && performance.now() < seekAt) {
    await observe("analysis");
    if (!pending) break;
    const remaining = seekAt - performance.now();
    if (remaining > 0) await wait(Math.min(16, remaining));
  }
  checkFailure();
  const remaining = seekAt - performance.now();
  if (remaining > 0) await wait(remaining);
  checkFailure();
  await observe("before-seek");
  if (observed) return { status: "observed" };
  if (pending) throw new Error("No rendered signal observed during analysis");
  return { status: "inconclusive", reason: "analysis-completed-before-observation" };
}
