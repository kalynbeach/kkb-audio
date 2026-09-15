import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { wavFixture } from "./local-wav-fixture";

// Opt-in bounded evidence, never a daily-driver server or audible run.
const url = new URL(process.env.PLAYER_URL ?? "http://invalid/");
const evidence = process.env.PLAYER_EVIDENCE;
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !evidence?.startsWith('/') || !process.cwd().includes('/kkb-audio-23-validation-')) throw new Error('Require isolated #23 copy, loopback PLAYER_URL and absolute PLAYER_EVIDENCE');
mkdirSync(evidence, { recursive: true });
const fixtures = join(evidence, 'fixtures'); mkdirSync(fixtures, { recursive: true });
for (const [name, rate, channels] of [['opposed', 48000, 2], ['right', 48000, 2], ['distinct', 48000, 2], ['silence', 48000, 1], ['converted', 44100, 1]] as const) {
  const frames = rate * 90;
  const bytes = wavFixture(16, channels, rate, frames, true); const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const frequency = name === 'distinct' && channel === 1 ? 330 : 220;
    const amplitude = name === 'silence' || (name === 'right' && channel === 0) ? 0 : 0.6;
    const sample = Math.round(Math.sin(frame * 2 * Math.PI * frequency / rate) * amplitude * 32767 * (name === 'opposed' && channel === 1 ? -1 : 1));
    view.setInt16(44 + (frame * channels + channel) * 2, sample, true);
  }
  await Bun.write(join(fixtures, `${name}.wav`), bytes);
}
const packet = new Uint8Array(await Bun.file('tools/fixtures/mp3/cbr-48000-2.mp3').arrayBuffer()).slice(384, 768);
const mp3 = new Uint8Array(384 * 3750); for (let p = 0; p < mp3.length; p += packet.length) mp3.set(packet, p);
await Bun.write(join(fixtures, 'actual.mp3'), mp3);
const session = `oscilloscope-23-${process.pid}`;
function browser(...args: string[]): unknown {
  const result = Bun.spawnSync(['agent-browser', '--session', session, '--json', ...args], { env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: '30000' } });
  const text = result.stdout.toString();
  const response: { success: boolean; error?: string; data?: { result?: unknown } } = JSON.parse(text);
  if (result.exitCode || !response.success) throw new Error(`${args.join(' ')}: ${response.error ?? result.stderr.toString()}`);
  return response.data?.result ?? response.data;
}
const evaluate = (source: string) => browser('eval', source);
const wait = (source: string) => browser('wait', '--fn', source);
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const phase = (name: string) => wait(`document.querySelector('.player-time [role=status]').textContent===${JSON.stringify(name)}`);
let assertions = 0;
const assert = (source: string, message: string) => { evaluate(`if(!(${source}))throw Error(${JSON.stringify(message)})`); assertions++; console.log(`PASS ${message}`); };
const settled = () => wait("document.getAnimations().every(a=>a.playState==='finished')");
const shot = (name: string) => { settled(); browser('screenshot', join(evidence!, `${name}.png`)); };
const settings = () => { click('Settings'); wait("!!document.querySelector('.player-settings')"); settled(); };
const dismiss = () => { browser('press', 'Escape'); wait("!document.querySelector('.player-settings') && !document.querySelector('.player-volume-popup')"); settled(); };
const label = (text: string) => wait(`document.querySelector('.player-oscilloscope [role=status]')?.textContent.includes(${JSON.stringify(text)})`);
const row = (name: string) => { if (!evaluate("!!document.querySelector('.player-library')")) { click('Show library'); settled(); } browser('focus', `[aria-label=${JSON.stringify(`Play ${name}`)}]`); click(`Play ${name}`); phase('Playing'); };
try {
  browser('--args', '--mute-audio', 'open', url.href); browser('set', 'viewport', '1440', '1000');
  evaluate(`window.probe={contexts:[],workers:[],snapshots:[],analysers:[],edges:[],draws:[],readCount:0,drawCount:0,failRead:false,failDraw:false,unavailable:false,record:false,signalResults:[]};
    const A=AudioContext,W=Worker,N=AudioWorkletNode,AN=AnalyserNode;
    window.AudioContext=new Proxy(A,{construct(T,args){const c=new T(...args);probe.contexts.push(c);return c}});
    window.Worker=new Proxy(W,{construct(T,args){const w=new T(...args),r={url:String(args[0]),terminated:false};probe.workers.push(r);const stop=w.terminate.bind(w);w.terminate=()=>{r.terminated=true;stop()};return w}});
    window.AudioWorkletNode=new Proxy(N,{construct(T,args){const n=new T(...args);n.port.addEventListener('message',e=>{if(e.data.type==='snapshot'){probe.snapshots.push(e.data.snapshot);if(probe.snapshots.length>1000)probe.snapshots.shift()}});return n}});
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    AudioNode.prototype.connect=function(...args){const result=connect.apply(this,args);probe.edges.push({source:this,destination:args[0],output:args[1]??0});return result};
    AudioNode.prototype.disconnect=function(...args){const result=disconnect.apply(this,args);probe.edges=probe.edges.filter(e=>e.source!==this||(args.length&&typeof args[0]!=='number'&&e.destination!==args[0]));return result};
    window.AnalyserNode=new Proxy(AN,{construct(T,args){const n=new T(...args),r={node:n,reads:0,peak:0,zeroCrossings:0,samples:new Float32Array(2048)};probe.analysers.push(r);const get=n.getFloatTimeDomainData.bind(n);n.getFloatTimeDomainData=(out)=>{if(probe.failRead)throw Error('injected analyser read');get(out);r.reads++;probe.readCount++;r.peak=0;r.zeroCrossings=0;for(let i=0;i<out.length;i++){r.peak=Math.max(r.peak,Math.abs(out[i]));if(i&&out[i-1]<0&&out[i]>=0)r.zeroCrossings++}r.samples.set(out)};return n}});
    const get=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(...args){if(probe.unavailable&&args[0]==='2d')return null;return get.apply(this,args)};
    for(const name of ['fillRect','stroke','moveTo','lineTo']){const original=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(...args){if(probe.failDraw)throw Error('injected canvas draw');if(this.canvas.closest('.player-oscilloscope')){if(name==='fillRect'){probe.drawCount++;if(probe.record){probe.draws.push({start:performance.now(),ms:0,vertices:0});if(probe.draws.length>2000)probe.draws.shift()}}else if(probe.record&&probe.draws.length){const d=probe.draws.at(-1);if(name==='stroke')d.ms=performance.now()-d.start;else d.vertices++}}return original.apply(this,args)}};
  `);
  settings(); click('Light'); dismiss(); click('Volume'); wait("!!document.querySelector('[aria-label=Mute]')"); click('Mute'); dismiss();
  assert("document.querySelector('[aria-label=Volume]').title==='Volume (muted)'", 'player mute before any Play, browser launched --mute-audio');
  browser('upload', '#session-files', ...['opposed.wav', 'right.wav', 'distinct.wav', 'silence.wav', 'converted.wav', 'actual.mp3'].map(name => join(fixtures, name))); settled();
  assert('probe.contexts.length===0 && probe.workers.length===0', 'admission never creates playback/observations');
  row('opposed.wav'); label('Live oscilloscope');
  wait("document.querySelector('.player-waveform').dataset.complete==='true'");
  assert('probe.analysers.length===2 && probe.analysers.every(a=>a.peak>0.299&&a.peak<0.301)', 'actual phase-opposed stereo survives as two pre-mute traces with compiled 0.5 gain');
  assert('probe.analysers[0].samples.every((s,i)=>Math.abs(s+probe.analysers[1].samples[i])<0.0001)', 'separate analyser channels preserve opposing phase, not mono averaging');
  evaluate("probe.path=document.querySelector('.player-wave-envelope path').getAttribute('d');probe.context=probe.contexts.at(-1);probe.record=true;probe.workloadStart=performance.now();probe.snapshotStart=probe.snapshots.at(-1);probe.readStart=probe.readCount;probe.drawStart=probe.drawCount");
  // Finite actual foreground workload. No held callbacks/data, seeks or fixture mocks.
  await Bun.sleep(10000);
  evaluate('probe.record=false;probe.workloadEnd=performance.now();probe.snapshotEnd=probe.snapshots.at(-1);probe.readEnd=probe.readCount;probe.drawEnd=probe.drawCount');
  assert('probe.draws.length>100 && probe.draws.length<=310 && probe.draws.every(d=>d.vertices<=12290)', 'finite 10-second real rendering workload stays within cadence/vertex bounds');
  assert('probe.snapshotEnd.failureCode===0 && probe.snapshotEnd.memoryBytes===16777216 && probe.snapshotEnd.processCount>probe.snapshotStart.processCount', 'actual worklet continued with fixed memory during drawing');
  click('Pause'); phase('Paused'); label('last observed');
  evaluate('probe.frozen=probe.drawCount;probe.readsFrozen=probe.readCount'); await Bun.sleep(400);
  assert('probe.drawCount===probe.frozen&&probe.readCount===probe.readsFrozen', 'paused visual freezes without continued reads or draws');
  browser('focus', '#seek-position'); browser('press', 'ArrowRight'); phase('Paused'); label('Play to observe');
  assert('probe.edges.filter(e=>e.source instanceof AudioWorkletNode).length===1', 'paused seek disposes old tap, retaining only listening route');
  evaluate('probe.readsFrozen=probe.readCount'); await Bun.sleep(300);
  assert('probe.readCount===probe.readsFrozen', 'paused seek cannot read stale browser history');
  click('Play'); phase('Playing'); label('Live oscilloscope');
  click('Volume'); wait("!!document.querySelector('.player-volume-popup')"); browser('focus', '.player-volume-popup input[type=range]'); browser('press', 'ArrowRight'); dismiss();
  assert('probe.analysers.slice(-2).every(a=>a.peak>0.299&&a.peak<0.301)', 'changing listening gain while muted does not alter observed amplitude');
  assert("document.querySelector('.player-wave-envelope path').getAttribute('d')===probe.path", 'source waveform stable across live rendering, pause, seek and volume');
  // One batched composition inspection, both modes/three library layouts plus fallback states.
  for (const mode of ['Light', 'Dark']) {
    browser('set', 'viewport', '1440', '1000'); settings(); click(mode); dismiss(); label('Live oscilloscope');
    browser('focus', '#seek-position'); shot(`desktop-library-${mode.toLowerCase()}`);
    assert("document.querySelector('.player-card').getBoundingClientRect().width===380&&document.querySelector('.player-card').getBoundingClientRect().height===532&&document.querySelector('#seek-position').getBoundingClientRect().height===40", 'approved card and full 40px navigation dimensions');
    click('Hide library'); label('Live oscilloscope'); shot(`compact-${mode.toLowerCase()}`);
    assert("Math.abs(document.querySelector('.player-card').getBoundingClientRect().x+190-innerWidth/2)<1", 'player stays independently centered');
    click('Show library'); settled(); browser('set', 'viewport', '390', '844'); settled(); shot(`mobile-library-${mode.toLowerCase()}`);
    evaluate('probe.hiddenReads=probe.readCount;probe.hiddenDraws=probe.drawCount'); await Bun.sleep(300);
    assert("!document.querySelector('.player-oscilloscope')&&probe.readCount===probe.hiddenReads&&probe.drawCount===probe.hiddenDraws&&document.documentElement.scrollWidth<=innerWidth", 'narrow library replaces only visual and stops all observation reads/draws');
    assert('probe.contexts.at(-1)===probe.context&&probe.context.state==="running"', 'theme/library/viewport never recreate or suspend playback');
    click('Hide library'); label('Live oscilloscope'); shot(`mobile-visual-${mode.toLowerCase()}`);
    click('Show library'); settled();
  }
  click('Hide library'); label('Live oscilloscope');
  // Controlled visibility event establishes lifecycle only, not background throughput.
  evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));probe.hiddenReads=probe.readCount;probe.hiddenDraws=probe.drawCount"); await Bun.sleep(300);
  assert('probe.hiddenReads===probe.readCount&&probe.hiddenDraws===probe.drawCount&&probe.edges.filter(e=>e.source instanceof AudioWorkletNode).length===1', 'injected hidden state cancels drawing, detaches tap and clears history');
  evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))"); label('Live oscilloscope');
  browser('set', 'media', 'dark', 'reduced-motion'); label('Reduced motion');
  evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert(`(()=>{const c=document.querySelector('.player-oscilloscope canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let y=0;y<c.height;y++)if(Math.abs(y-c.height/2)>2)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]!==p[0]||p[i+1]!==p[1]||p[i+2]!==p[2])return false}return true})()`, 'reduced-motion backing pixels contain only the surface and intentional baseline');
  shot('reduced-motion-dark');
  evaluate('probe.reducedReads=probe.readCount;probe.reducedDraws=probe.drawCount'); await Bun.sleep(400);
  assert('probe.reducedReads===probe.readCount&&probe.reducedDraws===probe.drawCount&&probe.context.state==="running"', 'stable reduced-motion representation has no ongoing reads/draws and leaves audio running');
  browser('set', 'media', 'light'); label('Live oscilloscope');
  settings(); click('Pause visual'); dismiss(); label('Visual paused');
  evaluate('probe.manualReads=probe.readCount;probe.manualDraws=probe.drawCount'); await Bun.sleep(300);
  assert('probe.manualReads===probe.readCount&&probe.manualDraws===probe.drawCount&&probe.context.state==="running"', 'Settings Pause visual is separate from audio pause');
  settings(); click('Resume visual'); dismiss(); label('Live oscilloscope');
  browser('set', 'viewport', '1440', '1000');
  for (const name of ['right.wav', 'distinct.wav', 'silence.wav', 'converted.wav', 'actual.mp3']) {
    row(name); label('Live oscilloscope');
    const mono = name==='silence.wav'||name==='converted.wav';
    wait(`probe.analysers.slice(-${mono?1:2}).every(a=>a.reads>2)`);
    if(name==='right.wav') assert('probe.analysers.at(-2).peak===0&&probe.analysers.at(-1).peak>0.299', 'actual right-only stereo is not erased');
    if(name==='distinct.wav') assert('Math.abs(probe.analysers.at(-2).zeroCrossings-9)<=1&&Math.abs(probe.analysers.at(-1).zeroCrossings-14)<=1', 'actual distinct L/R frequencies remain separate');
    if(name==='silence.wav') assert('probe.analysers.at(-1).peak===0', 'actual mono silence is a flat signal, not fabricated motion');
    if(name==='converted.wav') assert('probe.analysers.at(-1).peak>0.298&&probe.analysers.at(-1).peak<0.302&&probe.contexts.at(-1).sampleRate===48000', '44.1-to-48k rendered mono conversion is observed at output rate');
    if(name==='actual.mp3') assert('probe.analysers.slice(-2).some(a=>a.peak>0.001)', 'actual supported MP3 shares the same live renderer');
    evaluate(`probe.signalResults.push({name:${JSON.stringify(name)},channels:probe.analysers.slice(-${mono?1:2}).map(a=>({peak:a.peak,zeroCrossings:a.zeroCrossings,reads:a.reads}))})`);
    assert('probe.contexts.slice(0,-1).every(c=>c.state==="closed")', 'replacement closes all obsolete contexts');
  }
  wait("document.querySelector('.player-waveform').dataset.complete==='true'");
  evaluate("probe.mp3Path=document.querySelector('.player-wave-envelope path').getAttribute('d')");
  browser('focus', '#seek-position'); browser('press', 'End'); phase('Ended'); label('Ended');
  assert('probe.contexts.at(-1).state==="suspended"', 'ended representation reflects terminal suspended playback');
  click('Replay'); phase('Playing'); label('Live oscilloscope');
  assert("document.querySelector('.player-wave-envelope path').getAttribute('d')===probe.mp3Path", 'MP3 EOS/replay preserves independent complete source summary');
  settings(); click('Light'); dismiss();
  evaluate('probe.failDraw=true'); label('Visual unavailable'); phase('Playing'); shot('renderer-failure-light');
  assert('probe.edges.filter(e=>e.source instanceof AudioWorkletNode).length===1', 'canvas failure releases tap without touching listening route');
  click('Pause'); phase('Paused'); browser('focus', '#seek-position'); browser('press', 'Home'); phase('Paused'); click('Play'); phase('Playing');
  evaluate('probe.failDraw=false;probe.unavailable=true'); click('Hide library'); settled(); // desktop visual remains mounted
  browser('set', 'viewport', '390', '844'); click('Show library'); settled(); click('Hide library'); label('Visual unavailable'); phase('Playing'); shot('renderer-unavailable-light');
  assert('probe.contexts.at(-1).state==="running"&&!document.querySelector("[role=alert]")', 'unsupported Canvas2D leaves independent transport functional');
  evaluate('probe.unavailable=false'); click('Show library'); settled(); click('Hide library'); label('Live oscilloscope');
  evaluate('probe.failRead=true'); label('Visual unavailable'); phase('Playing');
  assert('probe.contexts.at(-1).state==="running"', 'injected analyser read failure is visual-only');
  settings(); click('Close track'); dismiss(); phase('No track loaded');
  assert('probe.contexts.every(c=>c.state==="closed")&&probe.workers.every(w=>w.terminated)', 'close releases every created context and worker');
  assert('probe.edges.filter(e=>e.source instanceof AudioWorkletNode||e.source instanceof AnalyserNode||e.source instanceof ChannelSplitterNode).length===0', 'close leaves no tap/worklet observation edges');
  const output = evaluate('({userAgent:navigator.userAgent,contextRates:probe.contexts.map(c=>c.sampleRate),workload:{milliseconds:probe.workloadEnd-probe.workloadStart,readCount:probe.readEnd-probe.readStart,drawCount:probe.drawEnd-probe.drawStart,draws:probe.draws,start:probe.snapshotStart,end:probe.snapshotEnd},signals:probe.signalResults,workers:probe.workers,snapshots:probe.snapshots})');
  await Bun.write(join(evidence, 'observations.json'), JSON.stringify(output, null, 2));
  const errors = browser('errors');
  await Bun.write(join(evidence, 'page-errors.json'), JSON.stringify(errors, null, 2));
  if (!errors || typeof errors !== 'object' || !('errors' in errors) || !Array.isArray(errors.errors) || errors.errors.length) throw new Error(JSON.stringify(errors));
  console.log(`PASS ${assertions} browser assertions; evidence ${evidence}`);
} catch (error) {
  await Bun.write(join(evidence, 'failure.txt'), String(error));
  console.log('Failure state:', JSON.stringify(browser('snapshot', '-i'))); browser('screenshot', join(evidence, 'failure.png')); throw error;
} finally { browser('close'); }
