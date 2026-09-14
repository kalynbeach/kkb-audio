import { useEffect, useId, useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { wavLoopRegion } from "./wav-loop";
import type { PlaybackOwner, PlaybackState } from "./playback-owner";

function boundaryTime(frame: number, rate: number): string {
  const seconds=frame/rate;
  return `${Math.floor(seconds/60)}:${(seconds%60).toFixed(6).padStart(9,"0")}`;
}
function BoundaryField({ name, frame, rate, onCommit }: { name: string; frame: number; rate: number; onCommit: (frame: number) => boolean }) {
  const saved=boundaryTime(frame,rate);
  const [text,setText]=useState(saved);
  const [invalid,setInvalid]=useState(false);
  const id=useId();
  useEffect(()=>{setText(saved);setInvalid(false);},[saved]);
  const commit=()=>{
    if(text===saved)return;
    const frames=/^(\d+)f$/.exec(text);
    const time=/^(\d+):([0-5]\d)(\.\d+)?$/.exec(text);
    const value=frames?Number(frames[1]):time?Math.round((Number(time[1])*60+Number(time[2])+Number(time[3]??0))*rate):NaN;
    if(!Number.isSafeInteger(value)){setInvalid(true);return;}
    setInvalid(!onCommit(value));
  };
  return <label className="player-loop-field"><span className="player-pixel">{name}</span><Input aria-label={`Loop ${name} time`} value={text} aria-invalid={invalid} aria-describedby={invalid?id:undefined} title={`Source frame ${frame}. mm:ss.fraction or integer frames followed by f.`}
    onChange={e=>{setText(e.currentTarget.value);setInvalid(false);}} onBlur={commit} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();commit();}if(e.key==="Escape"){e.preventDefault();setText(saved);setInvalid(false);}}}/>{invalid?<span id={id} role="alert" className="sr-only">Use mm:ss.fraction or source frames followed by f, within a legal region of at least 8 output frames.</span>:null}</label>;
}
export function PlayerLoopEditor({state,owner}:{state:PlaybackState;owner:PlaybackOwner}){
  const r=state.loop.region;
  if(state.phase==="error")return <div className="player-loop-overlay" role="group" aria-label="Loop editor"><p role="status">Loop Failed — source unavailable. Retry this track from the library. Loop controls cannot recover a terminated worker.</p></div>;
  if(!r)return <div className="player-loop-overlay" role="group" aria-label="Loop editor"><p role="status">{state.loop.error??"WAV loops unavailable. MP3 loops are not supported."}</p></div>;
  const commit=(a:number,b:number)=>{void owner.setLoopRegion(a,b);try{wavLoopRegion(a,b,state.sourceRate,state.outputRate,state.totalFrames);return true;}catch{return false;}};
  return <div className="player-loop-overlay" role="group" aria-label="Loop editor">
    <div className="player-loop-fields">
      <BoundaryField name="A" frame={r.a} rate={state.sourceRate} onCommit={a=>commit(a,r.b)}/>
      <BoundaryField name="B" frame={r.b} rate={state.sourceRate} onCommit={b=>commit(r.a,b)}/>
      <label className="player-loop-enable"><input type="checkbox" checked={state.loop.enabled} onChange={e=>{void owner.setLoopEnabled(e.currentTarget.checked);}}/>Loop</label>
      <Button variant="ghost" size="xs" onClick={()=>{void owner.setLoopRegion(0,state.totalFrames);}}>Reset</Button>
    </div>
    <p className="player-loop-message" role="status">{state.loop.error??(state.loop.phase==="Preparing"?"Preparing loop…":state.loop.phase==="Failed"?"Loop preparation failed.":state.loop.phase)}</p>
    <details className="player-loop-details"><summary>Loop coordinates & limits</summary>
      <p>Requested source [{r.a}, {r.b}) at {state.sourceRate} Hz; duration {(r.b-r.a)/state.sourceRate}s.</p>
      <p>Realized output [{r.pcmA}, {r.pcmB}) at {state.outputRate} Hz; period {r.period} frames ({r.period/state.outputRate}s). Realized start cursor {Math.floor(r.pcmA*state.sourceRate/state.outputRate)}.</p>
      <p>Converted boundaries round up. This fixed output period repeats; quantization relative to requested source duration accumulates over iterations. Held-head smoothing transforms the last {r.fade} frames; no frames shorten the realized period. Not universally click-free; listening validation pending.</p>
      <p>Exact fields accept mm:ss.fraction or source frames followed by f. Shift-drag creates a region; handles use arrows 1s, Shift 5s. Outside seek/edit disables looping.</p>
      <p>Iteration {state.snapshot?.loopIteration??0}; LoopUnderrun count {state.snapshot?.loopUnderruns??0}; accumulated extension {state.snapshot?.loopExtensionFrames??0} render frames; last failure discarded {state.snapshot?.loopLostFrames??0} remaining media PCM frames. Underrun extends the failed iteration with a {r.fade}-frame fade out, silence until re-prime, and {r.fade}-frame fade in.</p>
    </details>
  </div>;
}
