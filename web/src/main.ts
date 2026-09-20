import { PreparationLifecycle } from "./preparation-lifecycle";
import { PreparedProof, prepareProof } from "./prepared-playback";
import type { RenderSnapshot } from "./render-adapter";

export function mountPcmProof(root: Pick<Document, "querySelector">) {
  const events = new AbortController();
  const listen = (target: HTMLElement | null, event: string, handler: () => void) => target?.addEventListener(event, handler, { signal: events.signal });
  const prepareButton = root.querySelector<HTMLButtonElement>("#prepare");
  const activateButton = root.querySelector<HTMLButtonElement>("#activate");
  const failureButton = root.querySelector<HTMLButtonElement>("#failure");
  const closeButton = root.querySelector<HTMLButtonElement>("#close");
  const output = root.querySelector<HTMLElement>("#result");
  const proofLifecycle = new PreparationLifecycle<PreparedProof>();
  let controlsPending = false;

  listen(prepareButton, "click", async () => {
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

  listen(activateButton, "click", async () => {
    try {
      const result = await proofLifecycle.active?.activate();
      outputText(JSON.stringify({ state: "active", ...result }, null, 2));
    } catch (error) {
      outputText(errorText(error));
    }
  });

  listen(failureButton, "click", async () => {
    const preparation = proofLifecycle.tryExclusive(async () => {
      const unexpectedProof = await prepareProof({
        channelCount: 1,
        injectPreparationFailure: true,
        signal: events.signal,
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

  listen(closeButton, "click", async () => {
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
    if (events.signal.aborted) return;
    controlsPending = disabled;
    updateWavControls();
    const load = root.querySelector("#wav-load") as HTMLButtonElement | null;
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
    if (output !== null && !events.signal.aborted) {
      output.textContent = text;
    }
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  const wavFile = root.querySelector<HTMLInputElement>("#wav-file");
  const wavStall = root.querySelector<HTMLInputElement>("#wav-stall");
  const wavControls = ["wav-play", "wav-pause", "wav-status", "wav-seek"].map(id => root.querySelector(`#${id}`) as HTMLButtonElement);
  function updateWavControls(): void {
    const unavailable = proofLifecycle.active?.totalFrames === undefined;
    for (const control of wavControls) if (control) control.disabled = controlsPending || unavailable;
    if (wavStall) { wavStall.disabled = unavailable; if (unavailable) wavStall.checked = false; }
  }
  function wavStatus(proof: PreparedProof, snapshot: RenderSnapshot): void {
    outputText(JSON.stringify({ state: !snapshot.ready ? "preparing" : snapshot.ended ? "ended" : proof.paused ? "paused" : "playing", totalFrames: proof.totalFrames, sourceRate: proof.sourceRate, producerLastObserved: proof.producerObservation, ...snapshot }, null, 2));
  }
  listen(root.querySelector<HTMLElement>("#wav-load"), "click", async () => {
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
    listen(root.querySelector<HTMLElement>(`#${id}`), "click", async () => {
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
  listen(root.querySelector<HTMLElement>("#wav-seek"), "click", async () => {
    const proof = proofLifecycle.active;
    if (!proof) return;
    setPreparationControlsDisabled(true);
    try {
      const target = Number(root.querySelector<HTMLInputElement>("#wav-frame")?.value);
      const seek = await proof.seek(target);
      outputText(JSON.stringify({ seek, paused: proof.paused, ...await proof.status() }, null, 2));
    } catch (error) { outputText(errorText(error)); }
    finally { setPreparationControlsDisabled(false); }
  });
  listen(wavStall, "change", () => {
    try { proofLifecycle.active?.stall(wavStall?.checked ?? false); } catch (error) { outputText(errorText(error)); }
  });

  if (activateButton) activateButton.disabled = true;
  setPreparationControlsDisabled(false);
  outputText("idle");
  return () => { events.abort(); void proofLifecycle.closeActive(); };
}
