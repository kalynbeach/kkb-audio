import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Targeted actual-media-emulation regression. Requires the known fixture emitted by
// check-oscilloscope-browser.ts, never user music or a daily-driver build.
const url = new URL(process.env.PLAYER_URL ?? "http://invalid/");
const evidence = process.env.PLAYER_EVIDENCE;
const fixture = process.env.OSCILLOSCOPE_FIXTURE;
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !evidence?.startsWith('/') || !fixture?.startsWith('/tmp/') || !process.cwd().includes('/kkb-audio-23-validation-')) throw new Error('Require isolated #23 copy, loopback PLAYER_URL, absolute PLAYER_EVIDENCE and /tmp known OSCILLOSCOPE_FIXTURE');
mkdirSync(evidence, { recursive: true });
const session = `kkb23-reduced-${process.pid}`;
function browser(...args: string[]): unknown {
  const result = Bun.spawnSync(['agent-browser', '--session', session, '--json', ...args]);
  const response: { success: boolean; error?: string; data?: { result?: unknown } } = JSON.parse(result.stdout.toString());
  if (result.exitCode || !response.success) throw new Error(`${args.join(' ')}: ${response.error ?? result.stderr.toString()}`);
  return response.data?.result ?? response.data;
}
const evaluate = (source: string) => browser('eval', source);
const wait = (source: string) => browser('wait', '--fn', source);
const click = (name: string) => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
const settled = () => wait("document.getAnimations().every(a=>a.playState==='finished')");
try {
  browser('--args', '--mute-audio', 'open', url.href); browser('set', 'viewport', '390', '844');
  evaluate(`window.probe={draws:0,reads:0,contexts:[]};const A=AudioContext;window.AudioContext=new Proxy(A,{construct(T,args){const c=new T(...args);probe.contexts.push(c);return c}});
    const get=AnalyserNode.prototype.getFloatTimeDomainData;AnalyserNode.prototype.getFloatTimeDomainData=function(...args){probe.reads++;return get.apply(this,args)};
    const fill=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(...args){probe.draws++;return fill.apply(this,args)};`);
  click('Volume'); wait('!!document.querySelector("[aria-label=Mute]")'); click('Mute'); browser('press', 'Escape'); wait('!document.querySelector(".player-volume-popup")'); settled();
  evaluate('if(document.querySelector("[aria-label=Volume]").title!=="Volume (muted)")throw Error("Player must be muted before Play")');
  browser('upload', '#session-files', fixture); wait('!!document.querySelector(".player-track-play")'); settled(); browser('focus', '.player-track-play'); browser('click', '.player-track-play');
  wait('document.querySelector(".player-time [role=status]").textContent==="Playing"'); click('Hide library'); wait('document.querySelector(".player-oscilloscope [role=status]")?.textContent==="Live oscilloscope"'); settled();
  const inspect = `(()=>{const c=document.querySelector('.player-oscilloscope canvas'),f=document.querySelector('.player-oscilloscope figcaption'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let nonBaseline=0;for(let y=0;y<c.height;y++)if(Math.abs(y-c.height/2)>2)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(p[i]!==p[0]||p[i+1]!==p[1]||p[i+2]!==p[2])nonBaseline++}return{reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,caption:f.textContent,captionRect:f.getBoundingClientRect().toJSON(),canvasRect:c.getBoundingClientRect().toJSON(),hidden:c.hidden,width:c.width,height:c.height,nonBaseline,animations:document.getAnimations().map(a=>a.playState),draws:probe.draws,reads:probe.reads,contextState:probe.contexts.at(-1).state,time:performance.now()}})()`;
  const before = evaluate(inspect);
  browser('set', 'media', 'dark', 'reduced-motion'); wait('document.querySelector(".player-oscilloscope [role=status]").textContent.includes("Reduced motion")');
  evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); settled();
  const reduced = evaluate(inspect);
  evaluate('probe.stoppedDraws=probe.draws;probe.stoppedReads=probe.reads'); await Bun.sleep(500);
  const stable = evaluate(inspect);
  evaluate('if(probe.draws!==probe.stoppedDraws||probe.reads!==probe.stoppedReads||probe.contexts.at(-1).state!=="running")throw Error("Reduced-motion suppression/audio independence failed")');
  if (!reduced || typeof reduced !== 'object' || !('nonBaseline' in reduced) || reduced.nonBaseline !== 0) throw new Error(`Retained signal pixels: ${JSON.stringify(reduced)}`);
  browser('screenshot', join(evidence, 'reduced-motion-confirmed.png'));
  await Bun.write(join(evidence, 'reduced-motion.json'), JSON.stringify({ before, reduced, stable }, null, 2));
  console.log('PASS actual reduced-motion backing pixels cleared, visible caption, no ongoing reads/draws, audio still running');
} catch (error) { await Bun.write(join(evidence, 'failure.txt'), String(error)); console.log(JSON.stringify(browser('snapshot'))); throw error; }
finally { browser('close'); }
