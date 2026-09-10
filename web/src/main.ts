import { PreparationLifecycle } from "./preparation-lifecycle";
import { PreparedProof, prepareProof } from "./prepared-playback";
import type { RenderSnapshot } from "./render-adapter";

const prepareButton = document.querySelector<HTMLButtonElement>("#prepare");
const activateButton = document.querySelector<HTMLButtonElement>("#activate");
const failureButton = document.querySelector<HTMLButtonElement>("#failure");
const closeButton = document.querySelector<HTMLButtonElement>("#close");
const output = document.querySelector<HTMLElement>("#result");
const proofLifecycle = new PreparationLifecycle<PreparedProof>();
let controlsPending = false;

prepareButton?.addEventListener("click", async () => {
  const preparation = proofLifecycle.tryReplace(signal =>
    prepareProof({
      signal,
      channelCount: 2,
      maximumFrames: 1_024,
    }),
  );
  if (preparation === undefined) {
    return;
  }

  setPreparationControlsDisabled(true);
  if (activateButton !== null) {
    activateButton.disabled = true;
  }
  outputText("preparing");
  try {
    const prepared = await preparation;
    outputText(JSON.stringify({ state: "ready", ...prepared.ready }, null, 2));
    if (activateButton !== null) {
      activateButton.disabled = false;
    }
  } catch (error) {
    outputText(errorText(error));
  } finally {
    setPreparationControlsDisabled(false);
    updateWavControls();
  }
});

activateButton?.addEventListener("click", async () => {
  try {
    const result = await proofLifecycle.active?.activate();
    outputText(JSON.stringify({ state: "active", ...result }, null, 2));
  } catch (error) {
    outputText(errorText(error));
  }
});

failureButton?.addEventListener("click", async () => {
  const preparation = proofLifecycle.tryExclusive(async () => {
    const unexpectedProof = await prepareProof({
      channelCount: 1,
      injectPreparationFailure: true,
      maximumFrames: 1_024,
    });
    await unexpectedProof.close();
  });
  if (preparation === undefined) {
    return;
  }

  setPreparationControlsDisabled(true);
  try {
    await preparation;
    outputText("unexpected-ready");
  } catch (error) {
    outputText(
      JSON.stringify({ state: "failed", error: errorText(error) }, null, 2),
    );
  } finally {
    setPreparationControlsDisabled(false);
    updateWavControls();
  }
});

closeButton?.addEventListener("click", async () => {
  setPreparationControlsDisabled(true);
  try {
    await proofLifecycle.closeActive();
    if (activateButton !== null) activateButton.disabled = true;
    outputText("closed");
  } catch (error) {
    outputText(errorText(error));
  } finally {
    setPreparationControlsDisabled(false);
  }
});

function setPreparationControlsDisabled(disabled: boolean): void {
  controlsPending = disabled;
  updateWavControls();
  const load = document.querySelector("#wav-load") as HTMLButtonElement | null;
  if (load) load.disabled = disabled;
  if (prepareButton !== null) {
    prepareButton.disabled = disabled;
  }
  if (failureButton !== null) {
    failureButton.disabled = disabled;
  }
  if (closeButton !== null) {
    closeButton.disabled = false;
  }
}

function outputText(text: string): void {
  if (output !== null) {
    output.textContent = text;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const wavFile = document.querySelector<HTMLInputElement>("#wav-file");
const wavStall = document.querySelector<HTMLInputElement>("#wav-stall");
const wavControls = ["wav-play", "wav-pause", "wav-status", "wav-seek"].map(id => document.querySelector(`#${id}`) as HTMLButtonElement);
function updateWavControls(): void {
  const unavailable = proofLifecycle.active?.totalFrames === undefined;
  for (const control of wavControls) if (control) control.disabled = controlsPending || unavailable;
  if (wavStall) { wavStall.disabled = unavailable; if (unavailable) wavStall.checked = false; }
}
function wavStatus(proof: PreparedProof, snapshot: RenderSnapshot): void {
  outputText(JSON.stringify({ state: !snapshot.ready ? "preparing" : snapshot.ended ? "ended" : proof.paused ? "paused" : "playing", totalFrames: proof.totalFrames, sourceRate: proof.sourceRate, producerLastObserved: proof.producerObservation, ...snapshot }, null, 2));
}
document.querySelector("#wav-load")?.addEventListener("click", async () => {
  const file = wavFile?.files?.[0];
  if (!file) { outputText("Choose a local WAV file first."); return; }
  const pending = proofLifecycle.tryReplace(signal => prepareProof({ signal, file, channelCount: 2, maximumFrames: 1024 }));
  if (!pending) return;
  setPreparationControlsDisabled(true);
  if (activateButton) activateButton.disabled = true;
  outputText("Reading WAV headers and preparing bounded PCM…");
  try { const proof = await pending; if (wavStall) wavStall.checked = false; wavStatus(proof, await proof.status()); }
  catch (error) { outputText(errorText(error)); }
  finally { setPreparationControlsDisabled(false); updateWavControls(); }
});
for (const [id, action] of [["wav-play", "play"], ["wav-pause", "pause"], ["wav-status", "status"]] as const) {
  document.querySelector(`#${id}`)?.addEventListener("click", async () => {
    const pending = proofLifecycle.tryExclusive(async () => {
      const proof = proofLifecycle.active;
      if (proof?.totalFrames !== undefined) wavStatus(proof, await proof[action]());
    });
    if (!pending) return;
    setPreparationControlsDisabled(true);
    try { await pending; } catch (error) { outputText(errorText(error)); }
    finally { setPreparationControlsDisabled(false); }
  });
}
document.querySelector("#wav-seek")?.addEventListener("click", async () => {
  const proof = proofLifecycle.active;
  if (!proof) return;
  setPreparationControlsDisabled(true);
  try {
    const target = Number(document.querySelector<HTMLInputElement>("#wav-frame")?.value);
    const seek = await proof.seek(target);
    outputText(JSON.stringify({ seek, paused: proof.paused, ...await proof.status() }, null, 2));
  } catch (error) { outputText(errorText(error)); }
  finally { setPreparationControlsDisabled(false); }
});
wavStall?.addEventListener("change", () => {
  try { proofLifecycle.active?.stall(wavStall.checked); } catch (error) { outputText(errorText(error)); }
});
