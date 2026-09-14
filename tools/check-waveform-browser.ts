import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wavFixture } from "./local-wav-fixture";

// Opt-in isolated, muted evidence only. Never serve/build the daily driver.
const url = new URL(process.env.PLAYER_URL ?? "http://invalid/");
const evidence = process.env.PLAYER_EVIDENCE;
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !evidence?.startsWith("/") || !process.cwd().includes("/kkb-audio-18-validation-")) throw new Error("Require isolated #18 copy, loopback PLAYER_URL and absolute PLAYER_EVIDENCE");
mkdirSync(evidence, { recursive: true });
const session = `waveform-18-${process.pid}`;
const fixtures = mkdtempSync(join(tmpdir(), "kkb18-waveform-fixtures-"));
const frames = 48000 * 180;
const wav = wavFixture(16, 2, 48000, frames, true);
const view = new DataView(wav.buffer);
// Authored varying amplitude/opposite-phase channels; no user music.
for (let f = 0; f < frames; f++) {
  const envelope = Math.floor(f / 48000) % 30 < 3 ? 0 : 0.1 + 0.75 * Math.abs(Math.sin(f / 48000 * 0.09));
  const sample = Math.round(Math.sin(f * 2 * Math.PI * 220 / 48000) * envelope * 32767);
  view.setInt16(44 + f * 4, sample, true); view.setInt16(46 + f * 4, -sample, true);
}
await Bun.write(join(fixtures, "structure.wav"), wav);
const packet = new Uint8Array(await Bun.file("tools/fixtures/mp3/cbr-48000-2.mp3").arrayBuffer()).slice(384, 768);
const mp3 = new Uint8Array(384 * 25000);
for (let p = 0; p < mp3.length; p += packet.length) mp3.set(packet, p);
await Bun.write(join(fixtures, "bounded.mp3"), mp3);
function browser(...args: string[]): unknown {
  const result = Bun.spawnSync(["agent-browser", "--session", session, "--json", ...args], { env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "60000" } });
  const response: { success: boolean; error?: string; data?: { result?: unknown } } = JSON.parse(result.stdout.toString());
  if (result.exitCode || !response.success) throw new Error(`${args.join(" ")}: ${response.error ?? result.stderr.toString()}`);
  return response.data?.result ?? response.data;
}
const evaluate = (source: string) => browser("eval", source);
const wait = (source: string) => browser("wait", "--fn", source);
const click = (name: string) => browser("find", "role", "button", "click", "--name", name, "--exact");
const phase = (name: string) => wait(`document.querySelector('.player-time [role=status]').textContent===${JSON.stringify(name)}`);
const assert = (source: string, message: string) => { evaluate(`if(!(${source}))throw Error(${JSON.stringify(message)})`); console.log(`PASS ${message}`); };
const settled = () => wait("document.getAnimations().every(a=>a.playState==='finished')");
const shot = (name: string) => browser("screenshot", join(evidence!, `${name}.png`));
function settings() { click("Settings"); wait("!!document.querySelector('.player-settings')"); settled(); }
function dismiss() { browser("press", "Escape"); wait("!document.querySelector('.player-settings') && !document.querySelector('.player-volume-popup')"); settled(); }
function row(name: string) { browser("focus", `[aria-label=${JSON.stringify(`Play ${name}`)}]`); settled(); click(`Play ${name}`); }
function complete() { wait("document.querySelector('.player-waveform').dataset.complete==='true'"); }
function closeTrack() { settings(); click("Close track"); dismiss(); phase("No track loaded"); }
function library() { if (!evaluate("!!document.querySelector('.player-library')")) click("Show library"); settled(); }
try {
  browser("--args", "--mute-audio", "open", url.href); browser("set", "viewport", "1440", "1000");
  evaluate(`window.probe={workers:[],seeks:[],snapshots:[],hold:false,pending:[]};
    document.addEventListener('click',e=>{if(e.target.closest('button')?.textContent==='Close track')probe.closeClick=performance.now()},true);
    const W=window.Worker,N=window.AudioWorkletNode;
    window.Worker=new Proxy(W,{construct(T,args){const w=new T(...args),r={url:String(args[0]),started:performance.now(),terminated:false,messages:[],fail:()=>w.dispatchEvent(new Event('error'))};probe.workers.push(r);
      const stop=w.terminate.bind(w),post=w.postMessage.bind(w);w.terminate=()=>{r.terminated=true;r.stopped=performance.now();stop()};
      w.addEventListener('message',e=>{const m=e.data;if(m.type==='waveform-complete')r.complete={milliseconds:m.milliseconds,totalFrames:m.summary.totalFrames,bytes:m.summary.extrema.byteLength,memoryBytes:m.memoryBytes};if(m.type==='waveform-failed')r.failure=m.detail;r.messages.push(m.type)});
      w.postMessage=(...a)=>{if(a[0]?.type==='seek')probe.seeks.push(a[0]);if(probe.hold&&r.url.includes('waveform'))probe.pending.push(()=>post(...a));else post(...a)};return w;}});
    window.AudioWorkletNode=new Proxy(N,{construct(T,args){const n=new T(...args);n.port.addEventListener('message',e=>{if(e.data.type==='snapshot')probe.snapshots.push(e.data.snapshot)});return n;}});
  `);
  settings(); click("Light"); dismiss(); click("Volume"); wait("!!document.querySelector('[aria-label=Mute]')"); click("Mute"); dismiss();
  assert("document.querySelector('[aria-label=Volume]').title==='Volume (muted)'", "player muted before real Play; browser also --mute-audio");
  browser("upload", "#session-files", join(fixtures, "structure.wav"), join(fixtures, "bounded.mp3"), resolve("tools/fixtures/mp3/cbr-44100-2.mp3")); settled();
  assert("probe.workers.length===0", "collection admission does not analyse inactive files");
  row("structure.wav"); phase("Playing");
  assert("document.querySelector('.player-waveform').dataset.complete==='false' && document.querySelector('.player-wave-status').textContent==='Preparing waveform…'", "real WAV plays before overview completion");
  shot("wav-pending-light"); complete(); click("Pause"); phase("Paused");
  evaluate("probe.path=document.querySelector('.player-wave-envelope path').getAttribute('d');probe.count=probe.workers.length;probe.wavSnapshots=probe.snapshots.slice()");
  assert("probe.path.length>0 && probe.workers.filter(w=>w.url.includes('waveform')).length===1", "one real source summary completes");
  const rect = evaluate("document.querySelector('#seek-position').getBoundingClientRect().toJSON()") as Pick<DOMRect, "x" | "y" | "width" | "height">;
  const move = (fraction: number) => browser("mouse", "move", String(Math.round(rect.x + rect.width * fraction)), String(Math.round(rect.y + rect.height / 2)));
  evaluate("probe.before=probe.seeks.length;probe.cursor=document.querySelector('.player-consumed-cursor').style.left");
  move(0.1); browser("mouse", "down", "left"); move(0.4);
  assert("probe.seeks.length===probe.before && !!document.querySelector('.player-preview-cursor') && document.querySelector('.player-consumed-cursor').style.left===probe.cursor", "real pointer draft is separate from consumed cursor and performs no seek");
  browser("press", "Escape"); move(0.6); browser("mouse", "up", "left");
  assert("probe.seeks.length===probe.before && !document.querySelector('.player-preview-cursor')", "Escape cancels held pointer");
  move(0.1); browser("mouse", "down", "left"); move(0.5); browser("mouse", "up", "left"); phase("Paused");
  assert("probe.seeks.length===probe.before+1 && Math.abs(document.querySelector('#seek-position').valueAsNumber-90)<2", "one release acknowledges source-time seek");
  browser("focus", "#seek-position"); browser("press", "Home"); phase("Paused");
  assert("document.querySelector('#seek-position').valueAsNumber===0", "Home reaches exact start");
  browser("press", "End"); phase("Ended"); click("Replay"); phase("Playing"); click("Pause"); phase("Paused");
  click("Volume"); wait("!!document.querySelector('.player-volume-popup')"); browser("focus", ".player-volume-popup input[type=range]"); browser("press", "ArrowRight"); dismiss();
  assert("probe.workers.length===probe.count && document.querySelector('.player-wave-envelope path').getAttribute('d')===probe.path", "seek, EOS/replay and volume preserve complete summary");
  browser("focus", "#seek-position");
  for (let i = 0; i < 3; i++) { browser("press", "PageUp"); phase("Paused"); }
  // One bounded six-state visual batch, preserving approved composition and visual placeholder.
  for (const mode of ["Light", "Dark"]) {
    browser("set", "viewport", "1440", "1000"); settings(); click(mode); dismiss(); settled();
    browser("focus", "#seek-position"); shot(`desktop-library-${mode.toLowerCase()}`);
    assert("document.querySelector('.player-card').getBoundingClientRect().width===380 && document.querySelector('.player-card').getBoundingClientRect().height===532 && document.querySelector('#seek-position').getBoundingClientRect().height===40", "approved desktop and navigation dimensions");
    click("Hide library"); settled(); browser("focus", "#seek-position"); shot(`compact-${mode.toLowerCase()}`);
    assert("getComputedStyle(document.querySelector('.player-waveform')).outlineWidth==='2px' && !!document.querySelector('.player-visual')", "visible seek focus and separate unavailable visual");
    click("Show library"); settled(); browser("set", "viewport", "390", "844"); settled(); shot(`mobile-library-${mode.toLowerCase()}`);
    assert("!!document.querySelector('.player-main-field .player-library') && document.documentElement.scrollWidth<=innerWidth && !!document.querySelector('.player-wave-envelope')", "narrow library replaces only visual and retains waveform");
  }
  browser("set", "media", "dark", "reduced-motion"); click("Hide library"); settled();
  assert("getComputedStyle(document.querySelector('[aria-label=Volume]')).transitionDuration==='0s' && probe.workers.length===probe.count && document.querySelector('.player-wave-envelope path').getAttribute('d')===probe.path", "reduced motion, mode and library retain analysis");
  click("Show library"); settled();
  row("bounded.mp3"); phase("Playing");
  assert("document.querySelector('.player-waveform').dataset.complete==='false'", "600-second actual MP3 workload plays during independent source scan");
  evaluate("probe.mp3Start=probe.snapshots.length"); complete(); click("Pause"); phase("Paused");
  evaluate("probe.mp3Snapshots=probe.snapshots.slice(probe.mp3Start);probe.count=probe.workers.length;probe.path=document.querySelector('.player-wave-envelope path').getAttribute('d')");
  browser("focus", "#seek-position"); browser("press", "End"); phase("Ended"); click("Replay"); phase("Playing"); click("Pause"); phase("Paused");
  assert("probe.workers.length===probe.count && document.querySelector('.player-wave-envelope path').getAttribute('d')===probe.path", "MP3 endpoint/replay uses same complete summary");
  closeTrack(); library();
  row("bounded.mp3"); phase("Playing");
  evaluate("probe.cancelStart=performance.now();probe.cancelWorker=probe.workers.at(-1)"); closeTrack();
  assert("probe.cancelWorker.terminated && !document.querySelector('.player-wave-envelope')", "close terminates representative long scan and clears overview");
  evaluate("probe.cancelClickMilliseconds=probe.cancelWorker.stopped-probe.closeClick");
  // Actual replacement while scanning; no held messages in workload observations above.
  library(); row("bounded.mp3"); phase("Playing");
  evaluate("probe.replaced=probe.workers.at(-1)"); row("cbr-44100-2.mp3"); phase("Ended"); complete();
  assert("probe.replaced.terminated && probe.workers.at(-1).complete.totalFrames===6042", "replacement terminates obsolete long job; trimmed 44.1k MP3 owns result");
  click("Replay"); phase("Ended"); browser("focus", "#seek-position"); browser("press", "Home"); phase("Paused");
  // Controlled analysis-only failure proves functional playback (not performance evidence).
  closeTrack(); evaluate("probe.hold=true"); library(); row("structure.wav"); phase("Playing");
  evaluate("probe.workers.at(-1).fail();probe.hold=false;probe.pending=[]");
  wait("document.querySelector('.player-wave-status').textContent==='Waveform unavailable'");
  phase("Playing"); click("Pause"); phase("Paused"); browser("focus", "#seek-position"); browser("press", "ArrowRight"); phase("Paused");
  click("Play"); phase("Playing");
  assert("!document.querySelector('[role=alert]') && !document.querySelector('.player-wave-envelope')", "analysis-only failure leaves play/pause and seek available");
  closeTrack();
  assert("probe.workers.every(w=>w.terminated)", "all created workers disposed after close");
  assert("probe.snapshots.every(s=>s.memoryBytes===16777216 && s.failureCode===0)", "worklet memory stays fixed and runtime has no failure");
  const output = evaluate("({userAgent:navigator.userAgent,workers:probe.workers,seeks:probe.seeks,wavSnapshots:probe.wavSnapshots,mp3Snapshots:probe.mp3Snapshots,cancelMilliseconds:probe.cancelWorker.stopped-probe.cancelStart,cancelClickMilliseconds:probe.cancelClickMilliseconds})");
  await Bun.write(join(evidence!, "observations.json"), JSON.stringify(output, null, 2));
  const errors = browser("errors");
  if (!errors || typeof errors !== "object" || !("errors" in errors) || !Array.isArray(errors.errors) || errors.errors.length) throw new Error(JSON.stringify(errors));
  console.log("Browser page errors:", JSON.stringify(errors));
  console.log("Evidence:", evidence, "fixtures:", fixtures);
} catch (error) {
  console.log("Failure state:", JSON.stringify(browser("snapshot", "-i"))); shot("failure"); throw error;
} finally { browser("close"); }
