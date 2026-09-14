import { FakePlayback, deferred } from "./playback-fixture";
import { wavLoopRegion } from "../src/wav-loop";
export class FakeWavLoopPlayback extends FakePlayback {
  anchorAndDiscard=false;
  loopCalls:{a:number;b:number;enabled:boolean;edit:boolean}[]=[];
  pendingLoop:ReturnType<typeof deferred<void>>|undefined;
  async setLoop(a:number,b:number,enabled:boolean,edit=false){
    this.loopCalls.push({a,b,enabled,edit});
    const region=wavLoopRegion(a,b,this.sourceRate,this.ready.sampleRate,this.totalFrames);
    const cursor=this.snapshot.pcmPosition;
    const inside=cursor>=region.pcmA&&cursor<region.pcmB;
    const loopEnabled=enabled&&(!edit||inside);
    const pcm=enabled&&!edit&&!inside?region.pcmA:cursor;
    await this.pendingLoop?.promise;
    this.snapshot={...this.snapshot,epoch:this.snapshot.epoch+1,pcmPosition:pcm,sourcePosition:Math.floor(pcm*this.sourceRate/this.ready.sampleRate),ended:pcm===this.totalFrames,ready:true};
    return {epoch:this.snapshot.epoch,requestedFrame:this.snapshot.sourcePosition,actualMediaFrame:this.snapshot.sourcePosition,pcmFrame:pcm,result:"Exact" as const,loopEnabled};
  }
}
