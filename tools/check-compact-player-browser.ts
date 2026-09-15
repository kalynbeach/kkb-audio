import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wavFixture } from "./local-wav-fixture";

// Opt-in, device-free integration evidence. Run ONLY from the isolated source/build copy.
const url = new URL(process.env.PLAYER_URL ?? "http://invalid/");
const evidence = process.env.PLAYER_EVIDENCE;
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !evidence || !process.cwd().includes("kkb-audio-22-validation")) {
  throw new Error("Use isolated kkb-audio-22-validation copy, loopback PLAYER_URL and absolute PLAYER_EVIDENCE directory.");
}
const session = `compact-player-${process.pid}`;
const fixtures = mkdtempSync(join(tmpdir(), "kkb22-browser-fixtures-"));
const longName = "A very long local filename without artist or album metadata for honest truncation.wav";
await Bun.write(join(fixtures, "quiet.wav"), wavFixture(16, 2, 48000, 48000 * 30, true));
await Bun.write(join(fixtures, longName), wavFixture(24, 2, 44100, 44100 * 30, true));
await Bun.write(join(fixtures, "malformed.wav"), "not WAV data");
function browser(...args: string[]): unknown {
  const result = Bun.spawnSync(["agent-browser", "--session", session, "--json", ...args]);
  const response = JSON.parse(result.stdout.toString());
  if (result.exitCode || !response.success) throw new Error(`${args.join(" ")}: ${response.error ?? result.stderr.toString()}`);
  return response.data?.result ?? response.data;
}
const evaluate = (source: string) => browser("eval", source);
const wait = (source: string) => browser("wait", "--fn", source);
function click(name: string) { browser("find", "role", "button", "click", "--name", name, "--exact"); }
function shot(name: string) { browser("screenshot", join(evidence!, `${name}.png`)); }
function assert(source: string, message: string) {
  evaluate(`if (!(${source})) throw Error(${JSON.stringify(message)});`);
  console.log(`PASS ${message}`);
}
function phase(value: string) { wait(`document.querySelector('.player-time [role=status]').textContent===${JSON.stringify(value)}`); }
function settings() { click("Settings"); wait("!!document.querySelector('.player-settings') && document.getAnimations().every(a=>a.playState==='finished')"); }
function dismiss() { browser("press", "Escape"); wait("!document.querySelector('.player-settings') && !document.querySelector('.player-volume-popup')"); }
function rowPlay(name: string) {
  browser("focus", `[aria-label=${JSON.stringify(`Play ${name}`)}]`); click(`Play ${name}`);
}
function geometry(width: number) {
  assert("document.documentElement.scrollWidth<=innerWidth", `${width}px no horizontal overflow`);
  assert("document.querySelector('#seek-position').getBoundingClientRect().height===40", `${width}px 40px functional navigation target`);
  assert("[...document.querySelectorAll('.player-track-row')].every(e=>e.getBoundingClientRect().height===68)", `${width}px stable 68px rows`);
  assert("Math.abs(document.querySelector('.player-card').getBoundingClientRect().x+document.querySelector('.player-card').getBoundingClientRect().width/2-innerWidth/2)<1", `${width}px centered player`);
}
function realPointerSeek() {
  const rect = evaluate("document.querySelector('#seek-position').getBoundingClientRect().toJSON()") as { x: number; y: number; width: number; height: number };
  evaluate("probe.seekNode=document.querySelector('#seek-position'); probe.position=probe.seekNode.valueAsNumber; probe.elapsed=document.querySelector('[aria-label=\"Elapsed media time\"]').textContent; probe.seekCount=probe.seeks.length");
  const move = (fraction: number) => browser("mouse", "move", String(Math.round(rect.x + rect.width * fraction)), String(Math.round(rect.y + rect.height / 2)));
  move(0.1); browser("mouse", "down", "left"); move(0.4);
  assert("document.querySelector('#seek-position').getAttribute('aria-valuetext').startsWith('Preview') && document.querySelector('[aria-label=\"Elapsed media time\"]').textContent===probe.elapsed && probe.seeks.length===probe.seekCount", "real pointer previews without committing or changing consumed time");
  browser("press", "Escape"); move(0.6); browser("mouse", "up", "left");
  assert("Math.abs(document.querySelector('#seek-position').valueAsNumber-probe.position)<0.01 && probe.seeks.length===probe.seekCount", "real Escape cancellation blocks subsequent move/release commit");
  move(0.1); browser("mouse", "down", "left"); move(0.5); browser("mouse", "up", "left"); phase("Paused");
  assert("probe.seeks.length===probe.seekCount+1 && document.querySelector('#seek-position').valueAsNumber>14 && document.querySelector('#seek-position').valueAsNumber<16", "real pointer release commits exactly one acknowledged seek");
}
function errors() {
  const payload = browser("errors") as { errors?: unknown[] };
  console.log("Browser page errors:", JSON.stringify(payload));
  console.log("Browser console payload:", JSON.stringify(browser("console")));
  if (!Array.isArray(payload.errors) || payload.errors.length) throw new Error("Missing or nonempty browser page-error payload");
}
try {
  if (process.env.PLAYER_POINTER_ONLY === "1") {
    browser("--args", "--mute-audio", "open", url.href);
    browser("set", "viewport", "1440", "1000");
    evaluate("window.probe={seeks:[]};const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){if(args[0]?.type==='seek')probe.seeks.push(args[0]);return post.apply(this,args)}");
    click("Volume"); wait("!!document.querySelector('[aria-label=Mute]')"); click("Mute"); dismiss();
    browser("upload", "#session-files", join(fixtures, "quiet.wav"));
    wait("!!document.querySelector('.player-library') && document.getAnimations().every(a=>a.playState==='finished')");
    browser("snapshot", "-i"); browser("focus", '[aria-label="Play quiet.wav"]');
    wait("getComputedStyle(document.querySelector('[aria-label=\"Play quiet.wav\"]')).opacity==='1' && document.getAnimations().every(a=>a.playState==='finished')");
    click("Play quiet.wav"); phase("Playing"); click("Pause"); phase("Paused");
    realPointerSeek(); errors();
  } else {
  browser("--args", "--mute-audio", "open", url.href);
  browser("set", "viewport", "1440", "1000");
  evaluate(`window.probe={workers:[],contexts:[],seeks:[],hold:false,pending:[],transitions:0,done:true,exit:[],bounds:[]};
    const WorkerClass=window.Worker, ContextClass=window.AudioContext;
    window.Worker=new Proxy(WorkerClass,{construct(T,args){const w=new T(...args), record={worker:w,terminated:false}; probe.workers.push(record);
      const terminate=w.terminate.bind(w), post=w.postMessage.bind(w);
      w.terminate=()=>{record.terminated=true;terminate()};
      w.postMessage=(...args)=>{if(args[0]?.type==='seek')probe.seeks.push(args[0]);if(probe.hold)probe.pending.push(()=>post(...args));else post(...args)};return w;}});
    window.AudioContext=new Proxy(ContextClass,{construct(T,args){const c=new T(...args);probe.contexts.push(c);return c;}});
    window.bounds=()=>[...document.querySelectorAll('.player-card,.player-track-header,#seek-position,.player-transport')].map(e=>e.getBoundingClientRect().toJSON());
    if(document.startViewTransition){const start=document.startViewTransition.bind(document);probe.native=start;
      document.startViewTransition=(...args)=>{probe.transitions++;probe.done=false;probe.exit=[];probe.bounds=[];const t=start(...args);
        t.ready.then(()=>{const old=document.getAnimations().filter(a=>a.effect?.pseudoElement?.startsWith('::view-transition-old(')&&!a.effect.pseudoElement.includes('root'));
          const sample=()=>{if(probe.done)return;probe.bounds.push(JSON.stringify(bounds()));for(const a of old){const s=getComputedStyle(document.documentElement,a.effect.pseudoElement);probe.exit.push({finished:a.playState==='finished',opacity:Number(s.opacity),display:s.display})}requestAnimationFrame(sample)};sample()});
        t.finished.then(()=>probe.done=true);return t;};}
  `);
  settings(); click("Light"); dismiss();
  click("Volume"); wait("!!document.querySelector('[aria-label=Mute]')"); click("Mute"); dismiss();
  assert("document.querySelector('[aria-label=Volume]').title==='Volume (muted)'", "player mute engaged before any real playback");
  shot("desktop-empty-light");
  assert("document.querySelector('.player-card').getBoundingClientRect().width===380 && document.querySelector('.player-card').getBoundingClientRect().height===532", "approved 380 × 532 desktop object");
  evaluate("probe.baseline=JSON.stringify(bounds())");
  browser("upload", "#session-files", join(fixtures, "quiet.wav"), resolve("tools/fixtures/mp3/cbr-44100-2.mp3"), join(fixtures, longName), join(fixtures, "malformed.wav"));
  wait("!!document.querySelector('.player-library') && probe.done");
  assert("probe.workers.length===0 && probe.contexts.length===0", "multi-file admission creates no preparation worker or context");
  assert("[...document.querySelectorAll('.player-track-duration')].every(e=>e.textContent==='—')", "unprepared durations remain unknown");
  assert("JSON.stringify(bounds())===probe.baseline", "desktop companion does not shift persistent anatomy");
  geometry(1440); shot("desktop-library-unprepared-light");
  rowPlay("quiet.wav"); phase("Playing"); click("Pause"); phase("Paused");
  assert("probe.workers.length===1 && probe.contexts.length===1", "explicit WAV row play prepares exactly one worker/context");
  browser("focus", "#seek-position"); browser("press", "ArrowRight"); phase("Paused");
  assert("document.querySelector('#seek-position').valueAsNumber>=5", "real paused WAV keyboard seek acknowledges consumed position");
  realPointerSeek();
  click(`Select ${longName}`);
  assert("document.querySelector('h1').textContent==='quiet.wav'", "selection leaves active WAV identity untouched");
  click("Play"); phase("Playing");
  evaluate("probe.baseline=JSON.stringify(bounds())"); click("Hide library"); wait("probe.done && !document.querySelector('.player-library')");
  assert("probe.exit.length>0 && probe.exit.every(f=>!f.finished || f.display==='none' || f.opacity<0.01)", "library exit retains transparent final fill");
  assert("JSON.stringify(bounds())===probe.baseline && probe.bounds.every(b=>b===probe.baseline)", "persistent desktop geometry stays fixed throughout disclosure");
  assert("document.activeElement.getAttribute('aria-label')==='Show library'", "library close restores utility focus");
  shot("desktop-compact-light");
  click("Show library"); wait("probe.done && !!document.querySelector('.player-library')");
  settings(); click("Dark"); shot("desktop-settings-dark"); dismiss();
  browser("set", "viewport", "390", "844"); wait("!!document.querySelector('.player-main-field .player-library')");
  assert("probe.workers.length===1 && probe.contexts.length===1 && document.querySelector('#seek-position')===probe.seekNode", "library/theme/responsive changes retain actual worker/context and seek node");
  phase("Playing"); click("Pause"); phase("Paused"); geometry(390); shot("mobile-library-dark");
  assert("[...document.querySelectorAll('.player-track-play')].every(e=>getComputedStyle(e).opacity==='1' && e.getBoundingClientRect().width===44)", "narrow rows keep 44px playback targets visible");
  evaluate("probe.volumeTransitions=probe.transitions; probe.volumeFrames=[]; probe.sampleVolume=true; const sample=()=>{if(!probe.sampleVolume)return;const p=document.querySelector('.player-volume-popup');if(p)probe.volumeFrames.push(Number(getComputedStyle(p).opacity));requestAnimationFrame(sample)};sample()");
  click("Volume"); wait("document.querySelector('.player-volume-popup') && getComputedStyle(document.querySelector('.player-volume-popup')).opacity==='1'");
  assert("probe.transitions===probe.volumeTransitions && probe.volumeFrames.some(v=>v<0.9)", "Volume fades as one live Base UI surface without native snapshot competition");
  assert("[...document.querySelectorAll('.player-volume-popup button,.player-volume-popup [data-slot=slider-thumb],.player-volume-popup output')].every(e=>{const r=e.getBoundingClientRect();return document.querySelector('.player-volume-popup').contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})", "Volume controls hit-test above navigation");
  assert("getComputedStyle(document.querySelector('.player-volume-popup')).backgroundColor!=='rgba(0, 0, 0, 0)'", "Volume backing stays opaque");
  browser("focus", ".player-volume-popup input[type=range]"); browser("press", "ArrowRight");
  assert("document.querySelector('[aria-label=\"Volume level\"]').textContent==='16%'", "named Volume thumb supports keyboard adjustment while muted");
  shot("mobile-volume-dark"); evaluate("probe.volumeFrames=[]"); dismiss();
  assert("probe.volumeFrames.some(v=>v<0.1) && probe.volumeFrames.every((v,i,a)=>i===0||v<=a[i-1]+0.01)", "Volume exit is monotonic and finishes transparent");
  evaluate("probe.sampleVolume=false"); assert("document.activeElement.getAttribute('aria-label')==='Volume'", "Volume Escape returns focus");
  click("Return to visual"); wait("probe.done && !document.querySelector('.player-library')");
  settings(); click("Light"); dismiss(); shot("mobile-compact-light");
  click("Show library"); wait("probe.done && !!document.querySelector('.player-library')"); shot("mobile-library-light");
  browser("set", "viewport", "320", "568"); geometry(320); shot("narrow-320-light");
  browser("set", "viewport", "390", "844");
  // Existing authored MP3 is intentionally short: verify finite natural EOS and explicit replay, not a fake clock.
  rowPlay("cbr-44100-2.mp3"); phase("Ended");
  assert("document.querySelector('h1').textContent==='cbr-44100-2.mp3' && probe.contexts[0].state==='closed'", "real MP3 replacement reaches natural EOS and releases WAV context");
  evaluate("probe.count=probe.contexts.length"); click("Replay"); phase("Ended");
  assert("probe.contexts.length===probe.count", "MP3 replay reaches EOS on the same context without auto-advance");
  click("Next track"); phase("Paused");
  assert(`document.querySelector('h1').textContent===${JSON.stringify(longName)} && document.querySelector('#seek-position').valueAsNumber===0`, "next after EOS prepares at zero without autoplay");
  click("Play"); phase("Playing"); click("Previous track"); phase("Ended");
  assert("document.querySelector('h1').textContent==='cbr-44100-2.mp3'", "previous while playing explicitly continues intent into finite MP3");
  rowPlay("malformed.wav"); phase("Unavailable"); shot("mobile-error-light");
  assert("!!document.querySelector('[role=alert]') && document.querySelectorAll('.player-track-select').length===4", "malformed file leaves collection browsable with recovery feedback");
  rowPlay(longName); phase("Playing"); click("Pause"); phase("Paused");
  click("Hide library"); wait("probe.done && !document.querySelector('.player-library')"); shot("mobile-long-filename-light");
  settings(); click("Close track"); dismiss(); phase("No track loaded");
  evaluate("probe.hold=true"); click("Show library"); wait("probe.done && !!document.querySelector('.player-library')"); rowPlay("quiet.wav"); phase("Preparing…");
  click("Hide library"); wait("probe.done && !document.querySelector('.player-library')"); shot("mobile-loading-light");
  click("Cancel loading"); phase("No track loaded");
  evaluate("probe.hold=false;probe.pending=[]");
  assert("probe.workers.every(w=>w.terminated) && probe.contexts.every(c=>c.state==='closed')", "cancel held real worker startup disposes all obsolete work without successor");
  click("Show library"); wait("probe.done && !!document.querySelector('.player-library')"); rowPlay(longName); phase("Playing");
  click("Select quiet.wav"); evaluate("probe.count=probe.contexts.length"); settings(); click("Remove selected"); dismiss(); phase("Playing");
  assert("probe.contexts.length===probe.count && probe.contexts.at(-1).state==='running'", "inactive removal leaves actual playback running");
  click(`Select ${longName}`); settings(); click("Remove selected"); dismiss(); phase("No track loaded");
  assert("probe.contexts.at(-1).state==='closed' && document.querySelectorAll('.player-track-row').length===2", "active removal closes playback without choosing successor");
  settings(); click("Clear session"); dismiss();
  assert("document.querySelectorAll('.player-track-row').length===0 && document.querySelector('[aria-label=Volume]').title==='Volume (muted)'", "Clear releases entries and preserves mute/volume");
  evaluate("probe.saved=document.startViewTransition;document.startViewTransition=undefined"); click("Hide library"); click("Show library");
  assert("!!document.querySelector('.player-library')", "no-native-API library fallback remains functional");
  evaluate("document.startViewTransition=probe.saved");
  browser("set", "media", "light", "reduced-motion"); click("Hide library"); wait("probe.done");
  assert("getComputedStyle(document.querySelector('[aria-label=Volume]')).transitionDuration==='0s'", "reduced-motion removes live control transitions");
  settings(); click("System"); dismiss();
  assert("document.querySelector('meta[name=direction-contract]').content.includes('OWN-WORLD: user-pinned approved #21')", "emitted direction contract survives build");
  assert("[...document.fonts].filter(f=>['TX-02','Departure Mono','InterVariable'].includes(f.family)&&f.style==='normal').every(f=>f.status==='loaded')", "actual approved font files load");
  errors();
  console.log("Fixture directory:", fixtures);
  console.log("Muted Chromium only; no listening/device/background certification.");
  }
} catch (error) {
  console.log("Failure snapshot:", JSON.stringify(browser("snapshot", "-i")));
  console.log("Failure state:", JSON.stringify(evaluate("({phase:document.querySelector('.player-time').innerText,active:document.querySelector('h1').textContent,alert:document.querySelector('[role=alert]')?.textContent})")));
  console.log("Failure page errors:", JSON.stringify(browser("errors")));
  console.log("Failure console:", JSON.stringify(browser("console")));
  shot("pointer-failure");
  throw error;
} finally { browser("close"); }
