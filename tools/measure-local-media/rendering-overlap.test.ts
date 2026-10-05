import { expect, spyOn, test } from "bun:test";
import { sampleRenderingOverlap } from "./rendering-overlap";

function scenario(options: { completesAt?: number; signalPeak?: number; advances?: boolean; sampleMs?: number; analysisError?: Error; pollError?: Error } = {}) {
  let now = 0, analysing = true, activePolls = 0, maxPolls = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const analysis = Promise.withResolvers<string>();
  const samples: { phase: string; at: number; analysing: boolean }[] = [];
  const advance = async (ms: number) => {
    now += ms;
    if (analysing && now >= (options.completesAt ?? 32)) {
      analysing = false;
      if (options.analysisError) analysis.reject(options.analysisError);
      else analysis.resolve("waveform summary");
    }
    await Promise.resolve();
  };
  const run = () => sampleRenderingOverlap(analysis.promise, 1024, async phase => {
    activePolls++;
    maxPolls = Math.max(maxPolls, activePolls);
    samples.push({ phase, at: now, analysing });
    try {
      await advance(options.sampleMs ?? 2);
      if (options.pollError) throw options.pollError;
      return { analysing, snapshot: { renderFrame: now >= 16 && options.advances !== false ? 2048 : 1024 }, signalPeak: options.signalPeak ?? 0.2 };
    } finally { activePolls--; }
  }, advance);
  return { run, samples, analysis: analysis.promise, maxPolls: () => maxPolls, restore: () => clock.mockRestore() };
}

test.each([32, 96, 300])("observes advancing signal during %d ms analysis and preserves the seek point", async completesAt => {
  const run = scenario({ completesAt });
  try {
    expect(await run.run()).toEqual({ status: "observed" });
    expect(run.samples[0]).toEqual({ phase: "analysis", at: 0, analysing: true });
    expect(run.samples.at(-1)?.phase).toBe("before-seek");
    expect(run.samples.at(-1)?.at).toBe(150);
    expect(run.maxPolls()).toBe(1);
    expect(run.samples.filter(sample => sample.phase === "analysis").every(sample => sample.analysing)).toBe(true);
  } finally { run.restore(); }
});

test("fast analysis without overlap retains its waveform and lets the matrix continue", async () => {
  const rows = [];
  for (const completesAt of [1, 32]) {
    const run = scenario({ completesAt });
    try {
      rows.push({ renderingOverlap: await run.run(), waveform: await run.analysis });
      expect(run.samples.at(-1)?.at).toBe(150);
      if (completesAt === 1) expect(run.samples.map(sample => sample.phase)).toEqual(["analysis", "before-seek"]);
    } finally { run.restore(); }
  }
  expect(rows).toEqual([
    { renderingOverlap: { status: "inconclusive", reason: "analysis-completed-before-observation" }, waveform: "waveform summary" },
    { renderingOverlap: { status: "observed" }, waveform: "waveform summary" },
  ]);
});

test("does not credit signal collected after analysis completes during a slow status poll", async () => {
  const run = scenario({ completesAt: 32, sampleMs: 40 });
  try {
    expect((await run.run()).status).toBe("inconclusive");
    expect(run.maxPolls()).toBe(1);
    expect(run.samples.map(sample => sample.at)).toEqual([0, 150]);
  } finally { run.restore(); }
});

test.each([{ signalPeak: 0 }, { advances: false }])("still rejects absent rendering evidence while analysis remains pending: %j", async options => {
  const run = scenario({ ...options, completesAt: Infinity });
  try {
    await expect(run.run()).rejects.toThrow("No rendered signal observed during analysis");
    expect(run.maxPolls()).toBe(1);
  } finally { run.restore(); }
});

test.each(["analysis", "poll"] as const)("propagates %s failure and stops sampling", async source => {
  const error = new Error(`${source} failed`);
  const run = scenario({ completesAt: 1, ...(source === "analysis" ? { analysisError: error } : { pollError: error }) });
  try {
    await expect(run.run()).rejects.toBe(error);
    expect(run.samples.map(sample => sample.phase)).toEqual(["analysis"]);
    await Promise.resolve();
    expect(run.samples).toHaveLength(1);
  } finally { run.restore(); }
});

test("propagates an analysis failure after positive overlap", async () => {
  const error = new Error("waveform worker failed");
  const run = scenario({ completesAt: 32, analysisError: error });
  try {
    await expect(run.run()).rejects.toBe(error);
    expect(run.samples.map(sample => sample.at)).toEqual([0, 18]);
  } finally { run.restore(); }
});

test("a measurement deadline failure stops further polls", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(0);
  let polls = 0;
  try {
    await expect(sampleRenderingOverlap(new Promise(() => {}), 0, async () => {
      polls++;
      return { analysing: true, snapshot: { renderFrame: 0 }, signalPeak: 0 };
    }, async () => { throw new Error("Measurement exceeded deadline"); })).rejects.toThrow("Measurement exceeded deadline");
    expect(polls).toBe(1);
  } finally { clock.mockRestore(); }
});
