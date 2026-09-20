export {};

// Run against the simulated study route on a local Next.js server.
// Uses real Chromium snapshots: DOM-only test renderers cannot catch an exit flash.
const origin = process.env.PROTOTYPE_URL ?? "http://127.0.0.1:3000/developer/player-study";
const url = new URL(origin);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Use the local prototype server.");
const session = `player-prototype-motion-${process.pid}`;

function browser(...args: string[]) {
  const command = Bun.spawnSync(["agent-browser", "--session", session, "--json", ...args]);
  const response: { success: boolean; data?: { result?: unknown }; error?: string } = JSON.parse(command.stdout.toString());
  if (command.exitCode || !response.success) throw new Error(response.error ?? command.stderr.toString());
  return response.data?.result;
}
function click(name: string) { browser("find", "role", "button", "click", "--name", name, "--exact"); }
function settled() { browser("wait", "--fn", "window.motionProbe.started && window.motionProbe.done"); }

try {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    url.searchParams.set("view", "library");
    browser("open", url.href);
    browser("select", "select[aria-label=\"Appearance\"]", "light");
    browser("set", "viewport", String(width), String(height));
    browser("eval", `(() => {
      const probe = window.motionProbe = {started:false, done:false, frames:[], geometry:[], layers:[], baseline:null};
      window.measureSurfaces = () => [...document.querySelectorAll('.prototype-visual,.prototype-waveform,.prototype-card')].map(e => {
        const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height];
      });
      const start=document.startViewTransition.bind(document);
      document.startViewTransition=(...args) => {
        probe.started=true; probe.done=false; probe.frames=[]; probe.geometry=[]; probe.layers=[];
        const transition=start(...args);
        transition.ready.then(() => {
          for(const animation of document.getAnimations().filter(a=>a.animationName==='loop-fade')) {
            const pseudo=animation.effect.pseudoElement;
            const group=pseudo.replace(/::view-transition-(old|new)/,'::view-transition-group');
            probe.layers.push({filter:getComputedStyle(document.documentElement,pseudo).filter,zIndex:Number(getComputedStyle(document.documentElement,group).zIndex)});
          }
          const old=document.getAnimations().filter(a => a.effect?.pseudoElement?.startsWith('::view-transition-old(') && !a.effect.pseudoElement.includes('root'));
          function sample() {
            if(probe.done) return;
            for(const animation of old) {
              const style=getComputedStyle(document.documentElement,animation.effect.pseudoElement);
              probe.frames.push({opacity:Number(style.opacity),display:style.display,finished:animation.playState==='finished'});
            }
            probe.geometry.push(JSON.stringify(window.measureSurfaces()));
            requestAnimationFrame(sample);
          }
          sample();
        });
        transition.finished.then(() => probe.done=true);
        return transition;
      };
    })()`);
    click(width > 1211 ? "Close library" : "Return to visual");
    settled();
    browser("eval", `(() => {
      const frames=window.motionProbe.frames;
      if(!frames.length) throw Error('No exit snapshot frames observed');
      if(frames.some(f => f.finished && f.display!=='none' && f.opacity>0.01)) throw Error('Exit snapshot reappeared after fade completion');
    })()`);
    console.log(`PASS ${width}px library exit stays hidden after fading`);

    browser("eval", "window.motionProbe.baseline=JSON.stringify(window.measureSurfaces())");
    for (const action of ["Edit loop", "Close loop editor"]) {
      click(action);
      settled();
      browser("eval", `(() => {
        const p=window.motionProbe;
        if(JSON.stringify(window.measureSurfaces())!==p.baseline || p.geometry.some(frame=>frame!==p.baseline)) throw Error('Loop disclosure moved or resized the visual/waveform/card');
        if(!p.layers.length || p.layers.some(layer=>layer.filter!=='none' || layer.zIndex<1)) throw Error('Loop snapshot is blurred/clipped or not layered above the visual');
      })()`);
      if (action === "Edit loop") browser("eval", `(() => {
        const panel=document.querySelector('.prototype-loop-overlay');
        if(!panel) throw Error('Loop controls are not a single overlay surface');
        const p=panel.getBoundingClientRect(), v=document.querySelector('.prototype-visual').getBoundingClientRect();
        if(p.top<v.top || p.bottom>v.bottom+1 || p.bottom<=v.top) throw Error('Loop panel does not overlay the visual');
        if(getComputedStyle(panel).backgroundColor==='rgba(0, 0, 0, 0)') throw Error('Loop panel has no opaque surface');
        for(const label of panel.querySelectorAll('input,button')) {
          const r=label.getBoundingClientRect();
          if(r.top<p.top || r.bottom>p.bottom) throw Error('Loop controls clip outside the overlay');
        }
      })()`);
      console.log(`PASS ${width}px ${action}: stable surfaces throughout transition`);
    }

    browser("eval", `(() => {
      window.motionProbe.started=false;
      const probe=window.volumeProbe={frames:[],done:false};
      function sample() {
        if(probe.done) return;
        const popup=document.querySelector('.prototype-volume-popup');
        if(popup) {
          const style=getComputedStyle(popup);
          probe.frames.push({opacity:Number(style.opacity),background:style.backgroundColor});
        }
        requestAnimationFrame(sample);
      }
      sample();
    })()`);
    click("Volume");
    browser("wait", "--fn", "document.querySelector('.prototype-volume-popup') && getComputedStyle(document.querySelector('.prototype-volume-popup')).opacity==='1'");
    browser("eval", `(() => {
      const frames=window.volumeProbe.frames;
      if(!frames.length || !frames.some(f=>f.opacity<0.9)) throw Error('Volume did not fade in');
      if(frames.some((f,i)=>i>0 && f.opacity<frames[i-1].opacity-0.01)) throw Error('Volume opacity reversed during entry');
      if(frames.some(f=>f.background==='rgba(0, 0, 0, 0)')) throw Error('Volume lost its opaque backing');
      if(window.motionProbe.started) throw Error('Volume has competing snapshot and popup animation owners');
      const popup=document.querySelector('.prototype-volume-popup');
      for(const control of popup.querySelectorAll('button,[data-slot="slider-thumb"],output')) {
        const r=control.getBoundingClientRect();
        if(!popup.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))) throw Error('Player content paints over the volume surface');
      }
      window.volumeProbe.frames=[];
    })()`);
    click("Volume");
    browser("wait", "--fn", "!document.querySelector('.prototype-volume-popup')");
    browser("eval", `(() => {
      const frames=window.volumeProbe.frames;
      window.volumeProbe.done=true;
      if(!frames.length || !frames.some(f=>f.opacity<0.1)) throw Error('Volume unmounted before fading out');
      if(frames.some((f,i)=>i>0 && f.opacity>frames[i-1].opacity+0.01)) throw Error('Volume flashed during exit');
    })()`);
    console.log(`PASS ${width}px Volume: one opaque surface, monotonic fade in/out`);
  }
} finally {
  browser("close");
}
