import { expect, test } from "bun:test";
import { LocalMedia, PreparedRateConverter, WorkletKernel, initSync } from "../web/src/generated/kkb_audio.js";
import { PreparedPlanarAdapter } from "../web/src/render-adapter";
const module = await WebAssembly.compile(await Bun.file("web/dist/kkb_audio_bg.wasm").arrayBuffer());
const { memory } = initSync({ module });
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
function reference(bytes: Uint8Array, rate: number, tailOnly = false) {
  const r = new LocalMedia(BigInt(bytes.length), true);
  const step = () => { const at = Number(r.offset()); r.accept(bytes.subarray(at, at + r.length())); };
  while (r.length()) step();
  const total = r.total_frames(), sr = r.sample_rate(), channels = r.channels();
  const c = new PreparedRateConverter(sr, rate, channels, total);
  const length = Number(ceil(total * BigInt(rate), BigInt(sr)));
  const base = tailOnly ? Math.max(0,length-rate) : 0;
  const out = Array.from({ length: channels }, () => new Float32Array(length-base));
  r.seek(0n); let written = 0;
  while (written < length) {
    const needed = Math.min(73, c.input_frames_needed());
    if (needed) { r.request(needed); while (!r.available_frames()) step(); c.push(r.take(needed)); }
    const n = Math.min(97, c.available_frames());
    const skip=Math.min(n,Math.max(0,base-written));
    if(skip<n) out.forEach((p,ch)=>p.set(new Float32Array(memory.buffer,c.output_ptr(ch)+skip*4,n-skip),written+skip-base));
    c.consume(n); written += n;
  }
  c.free(); r.free(); return { total: Number(total), sr, channels, out, base };
}
test("MP3 shared built worker/rings/compiled Wasm loop PCM: independent trim/grid/seam, bounded continuation, recovery", async () => {
  const original = globalThis.self;
  const files = ["cbr-44100-1", "cbr-44100-2", "cbr-48000-1", "cbr-48000-2", "vbr-44100-1", "vbr-44100-2", "vbr-48000-1", "vbr-48000-2", "crc", "vbri", "short", "loop-crc-44100-1", "loop-crc-44100-2", "loop-crc-48000-1", "loop-crc-48000-2", "loop-dual-48000-2", "late"];
  for (const name of files) for (const missing of [false, true]) for (const ro of [44100, 48000]) {
    let bytes = new Uint8Array(await Bun.file(`tools/fixtures/mp3/${name === "late" ? "cbr-48000-2" : name}.mp3`).arrayBuffer());
    if(name==="late") { const packet=bytes.slice(384,768); bytes=new Uint8Array(25000*384); for(let at=0;at<bytes.length;at+=384)bytes.set(packet,at); }
    const tagOffset = bytes[3]! >> 6 === 3 ? 21 : 36;
    const tag = new TextDecoder().decode(bytes.subarray(tagOffset,tagOffset+4));
    const vbri = new TextDecoder().decode(bytes.subarray(36,40));
    if (missing && tag !== "Info" && tag !== "Xing" && vbri !== "VBRI") continue; // Already metadata-free: never drop a real audio packet.
    if (missing) { const sr = [44100,48000][(bytes[2]! >> 2) & 3]!; const kbps = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320][bytes[2]! >> 4]!; bytes = bytes.slice(Math.floor(144000 * kbps / sr) + ((bytes[2]! >> 1) & 1)); }
    const ref = reference(bytes, ro, name==="late"); const { total, sr, channels } = ref;
    const messages: {type:string;epoch?:number;loopRestorePackets?:number}[] = [];
    const host = { onmessage: undefined as ((e:{data:unknown})=>Promise<void>)|undefined, postMessage:(m:typeof messages[number])=>messages.push(m) };
    Object.defineProperty(globalThis,"self",{configurable:true,value:host});
    await import(`data:text/javascript;base64,${Buffer.from(await Bun.file("web/dist/pcm-worker.js").text()+`\n// ${name}${missing}${ro}`).toString("base64")}`);
    const send=(data:unknown)=>host.onmessage!({data});
    const wait=async(check:()=>boolean,budget=5000)=>{const end=performance.now()+budget;while(!check()){if(messages.some(m=>m.type==="worker-failed")||performance.now()>end)throw Error(`${name}: ${JSON.stringify(messages)}`);await Bun.sleep(1);}};
    let hold=false,failRead=false,release:(()=>void)|undefined;
    class ControlledFile extends File { override slice(a=0,b=this.size) { const blob=super.slice(a,b); if(a<65536)return blob; if(failRead)return {arrayBuffer:async()=>{throw Error("authored anchor read failure");}} as unknown as Blob; if(!hold)return blob; hold=false; return {arrayBuffer:async()=>{await new Promise<void>(r=>{release=r;});return blob.arrayBuffer();}} as Blob; } }
    await send({type:"inspect",file:new ControlledFile([bytes],`${name}.mp3`),module,sampleRate:ro});
    const k=new WorkletKernel(channels,ro,3n,1n,1024,1024); k.set_media_timeline(sr,BigInt(total));
    const adapter=new PreparedPlanarAdapter(channels,k,memory,1024),port=new MessageChannel();let epoch=1;
    port.port2.onmessage=e=>{const m=e.data;
      if(m.type==="supply"){port.port2.postMessage({type:"supply",loopUnderruns:Number(k.loop_underruns()),free:[0,1,2,3].map(i=>k.slot_free(i))});return;}
      if(m.type==="begin-seek"||m.type==="finish-seek") {const pcmFrame=m.type==="begin-seek"?Number(m.loopChange?k.begin_loop_change(BigInt(m.epoch),BigInt(m.loopChange.a),BigInt(m.loopChange.b),m.loopChange.enabled,m.loopChange.edit):m.recovery?k.begin_loop_recovery(BigInt(m.epoch)):k.begin_seek(BigInt(m.epoch),BigInt(m.target))):Number(k.pcm_position());if(m.type==="finish-seek")expect(k.finish_seek(BigInt(m.epoch))).toBe(true);port.port2.postMessage({type:"seek-transition",epoch:m.epoch,pcmFrame,loopEnabled:m.loopChange?k.loop_change_enabled():undefined,pauseRequired:!!m.loopChange&&k.loop_change_enabled()&&k.loop_change_ended()});return;}
      if(m.type==="loop-head"){if(!m.recovery)k.configure_loop(BigInt(m.a??0),BigInt(m.b??0),m.left??0,m.right??0,!m.disabled);return;}
      const accepted=adapter.acceptBlock(m);port.port2.postMessage({type:"admission-result",slotId:m.slotId,buffer:m.buffer,accepted},[m.buffer]);
    };
    const configure=async(a:number,b:number,recovery=false)=>{const id=++epoch;await send({type:"seek",epoch:id,target:a,loop:{a,b},recovery});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===id),35000);};
    try {
      await send({type:"initialize",config:{channelCount:channels,sampleRate:ro,sourceId:3,epoch,slotCount:4,slotFrames:1024},port:port.port1});await wait(()=>messages.some(m=>m.type==="worker-ready"));
      const regions=name==="late"?[[total-6000,total-6000+Number(ceil(4097n*BigInt(sr),BigInt(ro)))]]:total<32?[[0,total]]:[[0,total],[Math.min(2305,total-17),Math.min(2305,total-17)+17],...[total>5000?[total-5000,total-5000+Number(ceil(4097n*BigInt(sr),BigInt(ro)))]:[0,total]]];
      for(const [a,b] of regions) {
        if(b!>total)continue;
        const pa=Number(ceil(BigInt(a!)*BigInt(ro),BigInt(sr))),pb=Number(ceil(BigInt(b!)*BigInt(ro),BigInt(sr))),period=pb-pa,fade=Math.min(Math.floor(ro/200),Math.floor(period/4));
        const clock=k.next_frame();await configure(a!,b!);expect(k.next_frame()).toBe(clock);expect(k.pcm_position()).toBe(BigInt(pa));await send({type:"activate"});let consumed=0;
        const count=period<32?period*1000:period*3+19;
        while(consumed<count){await wait(()=>[0,1,2,3].every(i=>!k.slot_free(i)));const n=Math.min(997,count-consumed),out=Array.from({length:channels},()=>new Float32Array(n));adapter.process([out]);expect(k.loop_recovering()).toBe(false);
          for(let j=0;j<n;j++){const at=pa+(consumed+j)%period;for(let ch=0;ch<channels;ch++){const x=ref.out[ch]![at-ref.base]!;let y=x;if(at>=pb-fade){const j=at-(pb-fade),w=Math.fround(j/(fade-1));y=j===fade-1?ref.out[ch]![pa-ref.base]!:Math.fround(Math.fround(Math.fround(1-w)*x)+Math.fround(w*ref.out[ch]![pa-ref.base]!));}expect(out[ch]![j]).toBe(Math.fround(y*.5));}}
          consumed+=n;expect(k.pcm_position()).toBe(BigInt(pa+consumed%period));expect(k.ended()).toBe(false);
        }
      }
      await send({type:"stall",value:true});for(let i=0;i<8&&!k.loop_recovering();i++)adapter.process([Array.from({length:channels},()=>new Float32Array(1024))]);expect(k.loop_recovering()).toBe(true);const held=k.pcm_position(),clock=k.next_frame();adapter.process([Array.from({length:channels},()=>new Float32Array(1024))]);expect(k.pcm_position()).toBe(held);expect(k.next_frame()).toBe(clock+1024n);
      await send({type:"stall",value:false});const [a,b]=regions.at(-1)!;await configure(a!,b!,true);adapter.process([Array.from({length:channels},()=>new Float32Array(17))]);expect(k.loop_recovering()).toBe(false);expect(k.loop_underruns()).toBe(1n);expect(memory.buffer.byteLength).toBe(16777216);
      if(name==="crc"&&!missing&&ro===48000) {
        const ended=++epoch;await send({type:"seek",epoch:ended,target:total});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===ended));expect(k.ended()).toBe(true);
        const enabled=++epoch;await send({type:"seek",epoch:enabled,target:0,loopChange:{a:2305,b:total,enabled:true,edit:false}});await wait(()=>messages.some(m=>m.type==="loop-ended"&&m.epoch===enabled));expect(k.ready()).toBe(false);
        expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===enabled)).toBe(false);await send({type:"loop-paused",epoch:enabled});await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===enabled));expect(k.pcm_position()).toBe(2305n);expect(k.ended()).toBe(false);
      }
      if(name==="late") {
        hold=true;const obsolete=++epoch;await send({type:"seek",epoch:obsolete,target:total/2,loop:{a:total/2,b:total/2+5000}});await wait(()=>!!release);
        const wanted=++epoch;await send({type:"seek",epoch:wanted,target:100,loop:{a:100,b:1000}});release!();release=undefined;
        await wait(()=>messages.some(m=>m.type==="seek-complete"&&m.epoch===wanted));expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===obsolete)).toBe(false);expect(k.pcm_position()).toBe(BigInt(Number(ceil(100n*BigInt(ro),BigInt(sr)))));
        failRead=true;const failed=++epoch;await send({type:"seek",epoch:failed,target:total/2,loop:{a:total/2,b:total/2+5000}});
        const deadline=performance.now()+5000;while(!messages.some(m=>m.type==="worker-failed")){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(1);}expect(messages.some(m=>m.type==="seek-complete"&&m.epoch===failed)).toBe(false);expect(k.ready()).toBe(false);
      }
    } finally {release?.();await send({type:"stall",value:true});port.port1.close();port.port2.close();k.free();Object.defineProperty(globalThis,"self",{configurable:true,value:original});}
  }
},180000);
