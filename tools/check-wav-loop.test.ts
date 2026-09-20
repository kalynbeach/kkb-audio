import { expect, test } from "bun:test";
import { LocalWav, PreparedRateConverter, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
import { wavFixture } from "./local-wav-fixture";
const module=await WebAssembly.compile(await Bun.file("public/audio-runtime/kkb_audio_bg.wasm").arrayBuffer());
const {memory}=initSync({module});
type WorkerEvent = { type: string; epoch?: number; loopEnabled?: boolean; detail?: string };
function reference(bytes:Uint8Array,rate:number):Float32Array[]{
  const wav=new LocalWav(BigInt(bytes.length));
  while(wav.length()){const at=Number(wav.offset());wav.accept(bytes.subarray(at,at+wav.length()));}
  const c=new PreparedRateConverter(wav.sample_rate(),rate,wav.channels(),wav.total_frames());
  const out=Array.from({length:wav.channels()},()=>new Float32Array(Number(c.total_pcm_frames())));let written=0;
  try{while(written<out[0]!.length){const needed=Math.min(73,c.input_frames_needed());if(needed){const at=Number(wav.data_offset())+Number(c.source_frames_read())*wav.block_align();c.push(wav.decode(bytes.subarray(at,at+needed*wav.block_align())));}const n=Math.min(97,c.available_frames());out.forEach((p,ch)=>p.set(new Float32Array(memory.buffer,c.output_ptr(ch),n),written));c.consume(n);written+=n;}return out;}finally{c.free();wav.free();}
}

test("WAV loops actual built worker/Wasm: references, tiny multiple-wrap slots, latest edits, disable, starvation and exact-start recovery",async()=>{
  const original=globalThis.self;
  for(const [sr,ro,bits] of [[48000,48000,24],[44100,48000,24],[48000,44100,24],[48000,48000,32],[44100,48000,32],[48000,44100,32]] as const){
    const messages:WorkerEvent[]=[];
    const host={onmessage:undefined as ((e:{data:unknown})=>Promise<void>)|undefined,postMessage:(m:WorkerEvent)=>messages.push(m)};
    Object.defineProperty(globalThis,"self",{configurable:true,value:host});
    await import(`data:text/javascript;base64,${Buffer.from(await Bun.file("public/audio-runtime/pcm-worker.js").text()+`\n// wavloop${sr}${ro}${bits}`).toString("base64")}`);
    const send=(data:unknown)=>host.onmessage!({data});
    const wait=async(condition:()=>boolean)=>{const end=performance.now()+4000;while(!condition()){if(messages.some(m=>m.type==="worker-failed")||performance.now()>end)throw Error(JSON.stringify(messages));await Bun.sleep(1);}};
    const bytes=wavFixture(bits,2,sr,19007);const expected=reference(bytes,ro);
    let hold=false;let failRead=false;let release:(()=>void)|undefined;
    class ControlledFile extends File {override slice(a=0,b=this.size){const blob=super.slice(a,b);if(failRead&&a>=44)return {arrayBuffer:async()=>{throw Error("authored terminal read failure");}} as unknown as Blob;if(!hold||a<44)return blob;hold=false;return {arrayBuffer:async()=>{await new Promise<void>(r=>{release=r;});return blob.arrayBuffer();}} as Blob;}}
    await send({type:"inspect",file:new ControlledFile([bytes],"loop.wav"),module,sampleRate:ro});
    const k=new WorkletKernel(2,ro,3n,1n,1024,1024);k.set_media_timeline(sr,19007n);
    const adapter=new PreparedPlanarAdapter(2,k,memory,1024);const channel=new MessageChannel();let inFlight=0;let epoch=1;let headMessages=0;
    channel.port2.onmessage=e=>{const m=e.data;
      if(m.type==="supply"){channel.port2.postMessage({type:"supply",loopUnderruns:Number(k.loop_underruns()),free:[0,1,2,3].map(i=>k.slot_free(i))});return;}
      if(m.type==="begin-seek"||m.type==="finish-seek"){
        const pcmFrame=m.type==="begin-seek"?Number(m.loopChange?k.begin_loop_change(BigInt(m.epoch),BigInt(m.loopChange.a),BigInt(m.loopChange.b),m.loopChange.enabled,m.loopChange.edit):m.recovery?k.begin_loop_recovery(BigInt(m.epoch)):k.begin_seek(BigInt(m.epoch),BigInt(m.target))):Number(k.pcm_position());
        if(m.type==="finish-seek")expect(k.finish_seek(BigInt(m.epoch))).toBe(true);
        channel.port2.postMessage({type:"seek-transition",epoch:m.epoch,pcmFrame,loopEnabled:m.loopChange?k.loop_change_enabled():undefined,pauseRequired:!!m.loopChange&&k.loop_change_enabled()&&k.loop_change_ended()});return;
      }
      if(m.type==="loop-head"){headMessages++;if(!m.recovery)k.configure_loop(BigInt(m.a??0),BigInt(m.b??0),m.left??0,m.right??0,!m.disabled);return;}
      inFlight++;const accepted=adapter.acceptBlock(m);channel.port2.postMessage({type:"admission-result",slotId:m.slotId,buffer:m.buffer,accepted},[m.buffer]);inFlight--;
    };
    const configure=async(a:number,b:number,target=a,recovery=false)=>{const id=++epoch;await send({type:"seek",epoch:id,target,loop:{a,b},recovery});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===id));};
    try{
      await send({type:"initialize",config:{channelCount:2,sampleRate:ro,sourceId:3,epoch,slotCount:4,slotFrames:1024},port:channel.port1});await wait(()=>messages.some(m=>m.type==="worker-ready"));
      for(const [a,b]of [[0,17],[7001,17004],[18000,19007]]){
        const pa=Math.ceil(a!*ro/sr),pb=Math.ceil(b!*ro/sr),period=pb-pa,fade=Math.min(Math.floor(ro/200),Math.floor(period/4));
        const clock=k.next_frame();await configure(a!,b!);expect(k.next_frame()).toBe(clock);expect(k.pcm_position()).toBe(BigInt(pa));
        await send({type:"activate"});let consumed=0;
        for(const n of [1,17,257,1024,3,997,37,1024,1023]){
          await Bun.sleep(15);const out=[new Float32Array(n),new Float32Array(n)];adapter.process([out]);expect(k.loop_recovering()).toBe(false);
          for(let j=0;j<n;j++){const at=pa+(consumed+j)%period;for(let ch=0;ch<2;ch++){const x=expected[ch]![at]!;let y=x;if(at>=pb-fade){const j=at-(pb-fade);const w=Math.fround(j/(fade-1));y=j===fade-1?expected[ch]![pa]!:Math.fround(Math.fround(Math.fround(1-w)*x)+Math.fround(w*expected[ch]![pa]!));}expect(out[ch]![j]).toBe(Math.fround(y*0.5));}}
          consumed+=n;expect(k.pcm_position()).toBe(BigInt(pa+consumed%period));expect(k.loop_iteration()).toBe(BigInt(Math.floor((consumed-1)/period)));expect(k.ended()).toBe(false);
        }
      }
      // A held head read is superseded; no obsolete completion can arm it.
      hold=true;const obsolete=++epoch;await send({type:"seek",epoch:obsolete,target:7001,loop:{a:7001,b:17004}});await wait(()=>!!release);
      const wanted=++epoch;await send({type:"seek",epoch:wanted,target:100,loop:{a:100,b:1000}});release!();release=undefined;await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===wanted));expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===obsolete)).toBe(false);
      await send({type:"stall",value:true});
      for(let i=0;i<8&&!k.loop_recovering();i++)adapter.process([[new Float32Array(1024),new Float32Array(1024)]]);
      expect(k.loop_recovering()).toBe(true);const held=k.pcm_position();const before=k.next_frame();
      for(let i=0;i<4;i++){adapter.process([[new Float32Array(1024),new Float32Array(1024)]]);expect(k.pcm_position()).toBe(held);}
      expect(k.next_frame()).toBe(before+4096n);expect(k.loop_underruns()).toBe(1n);expect(k.loop_extension_frames()>0n).toBe(true);
      await send({type:"stall",value:false});await configure(100,1000,100,true);
      const out=[new Float32Array(17),new Float32Array(17)];adapter.process([out]);expect(k.loop_recovering()).toBe(false);
      const pa=Math.ceil(100*ro/sr),pb=Math.ceil(1000*ro/sr),fade=Math.min(Math.floor(ro/200),Math.floor((pb-pa)/4));
      for(let j=0;j<17;j++)for(let ch=0;ch<2;ch++)expect(out[ch]![j]).toBe(Math.fround(Math.fround(expected[ch]![pa+j]!*Math.fround((j+1)/fade))*0.5));
      expect(k.pcm_position()).toBe(BigInt(pa+17));
      // Loop controls capture exact PCM at acknowledgment, ignoring the intentionally stale target=0.
      const change=async(a:number,b:number,enabled:boolean,edit:boolean)=>{const id=++epoch;await send({type:"seek",epoch:id,target:0,loopChange:{a,b,enabled,edit}});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===id));return messages.find(m=>m.type==="seek-complete"&&m.epoch===id);};
      let exact=k.pcm_position();
      await change(100,1000,true,false);expect(k.pcm_position()).toBe(exact);
      if(sr<ro){for(let i=0;i<20&&BigInt(Math.ceil(Math.floor(Number(k.pcm_position())*sr/ro)*ro/sr))===k.pcm_position();i++)adapter.process([[new Float32Array(1),new Float32Array(1)]]);exact=k.pcm_position();expect(BigInt(Math.ceil(Math.floor(Number(exact)*sr/ro)*ro/sr))).not.toBe(exact);}
      const off=await change(100,1000,false,false);expect(off?.loopEnabled).toBe(false);expect(k.pcm_position()).toBe(exact);
      await change(100,1000,true,false);expect(k.pcm_position()).toBe(exact);
      const edited=await change(4000,5000,true,true);expect(edited?.loopEnabled).toBe(false);expect(k.pcm_position()).toBe(exact);
      const disabled=++epoch;await send({type:"seek",epoch:disabled,target:19007});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===disabled));expect(k.ended()).toBe(true);expect([0,1,2,3].every(i=>k.slot_free(i))).toBe(true);expect(inFlight).toBe(0);expect(memory.buffer.byteLength).toBe(16777216);
      // Renderer EOS is newer than any owner snapshot. Hold the main-thread
      // suspension acknowledgment: neither head nor consumable PCM may escape.
      const eosEpoch=++epoch;const headsBefore=headMessages;
      await send({type:"seek",epoch:eosEpoch,target:0,loopChange:{a:100,b:1000,enabled:true,edit:false}});
      await wait(()=>messages.some(m=>m.type==="loop-ended"&&m.epoch===eosEpoch));
      expect(k.loop_change_ended()).toBe(true);expect(k.ready()).toBe(false);
      const silent=[new Float32Array(17),new Float32Array(17)];adapter.process([silent]);
      expect(silent.every(p=>p.every(v=>v===0))).toBe(true);expect(headMessages).toBe(headsBefore);
      const latest=++epoch;await send({type:"seek",epoch:latest,target:0,loopChange:{a:200,b:1100,enabled:true,edit:false}});
      await send({type:"loop-paused",epoch:eosEpoch-1});await Bun.sleep(2);expect(headMessages).toBe(headsBefore);
      await send({type:"loop-paused",epoch:eosEpoch});
      await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===latest));
      expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===eosEpoch)).toBe(false);
      const resumed=[new Float32Array(17),new Float32Array(17)];const latestA=Math.ceil(200*ro/sr);
      expect(k.pcm_position()).toBe(BigInt(latestA));adapter.process([resumed]);
      for(let j=0;j<17;j++)for(let ch=0;ch<2;ch++)expect(resumed[ch]![j]).toBe(Math.fround(expected[ch]![latestA+j]!*0.5));
      const eosAgain=++epoch;await send({type:"seek",epoch:eosAgain,target:19007});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===eosAgain));
      failRead=true;const failed=++epoch;await send({type:"seek",epoch:failed,target:7001,loop:{a:7001,b:17004}});
      const deadline=performance.now()+3000;while(!messages.some(m=>m.type==="worker-failed")){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(1);}
      expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===failed)).toBe(false);expect(k.ready()).toBe(false);expect(k.loop_underruns()).toBe(1n);expect(messages.at(-1)?.detail).toContain("authored terminal read failure");
    }finally{release?.();await send({type:"stall",value:true});channel.port1.close();channel.port2.close();k.free();Object.defineProperty(globalThis,"self",{configurable:true,value:original});}
  }
},30000);
