/* A clip-local timeline over the original video, without raw-video native controls. */
(() => {
  const clock=t=>{const n=Math.max(0,t);return `${Math.floor(n/3600).toString().padStart(2,'0')}:${Math.floor(n%3600/60).toString().padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`;};
  class ClipPlayback {
    constructor(video,{range,play,display,mute,fullscreen,shell,onError=()=>{}}){
      Object.assign(this,{video,range,playButton:play,display,muteButton:mute,fullscreenButton:fullscreen,shell,onError});
      video.controls=false;this.clear();
      for(const event of ['timeupdate','seeked','seeking','loadedmetadata'])video.addEventListener(event,()=>this.update());
      video.addEventListener('play',()=>{
        if(!this.clip){video.pause();return;}
        if(video.currentTime>=this.clip.end-.001||video.currentTime<this.clip.start)video.currentTime=this.clip.start;
        this.update();
      });
      for(const event of ['pause','ended','volumechange'])video.addEventListener(event,()=>this.render());
      range.oninput=()=>{if(!this.clip)return;video.pause();this.seek(Number(range.value));};
      play.onclick=async()=>{
        if(!this.clip)return;
        if(!video.paused){video.pause();return;}
        if(video.currentTime>=this.clip.end-.001||video.currentTime<this.clip.start)video.currentTime=this.clip.start;
        try{await video.play();}catch(e){onError(e.message);}
      };
      if(mute)mute.onclick=()=>{video.muted=!video.muted;this.render();};
      if(fullscreen)fullscreen.onclick=async()=>{try{
        if(document.fullscreenElement===shell)await document.exitFullscreen();
        else if(shell?.requestFullscreen)await shell.requestFullscreen();
        else onError('Fullscreen is unavailable in this browser.');
      }catch(e){onError(e.message);}};
    }
    clear(){this.clip=null;this.video.pause();this.range.disabled=true;this.range.min=0;this.range.max=1;this.range.value=0;this.playButton.disabled=true;this.display.textContent='';}
    setClip(clip,elapsed=0){
      if(!Number.isFinite(clip.start)||!Number.isFinite(clip.end)||clip.end<=clip.start)throw Error('Invalid clip playback bounds.');
      this.video.pause();this.clip={start:clip.start,end:clip.end};this.duration=Number((clip.end-clip.start).toFixed(6));
      this.range.min=0;this.range.max=this.duration;this.range.step='0.01';this.range.disabled=false;this.playButton.disabled=false;
      this.seek(elapsed);
    }
    seek(elapsed){
      if(!this.clip)return;
      const value=Math.max(0,Math.min(this.duration,Number.isFinite(elapsed)?elapsed:0));
      this.video.currentTime=Math.min(this.clip.end,this.clip.start+value);this.render();
    }
    update(){
      if(!this.clip)return;
      if(this.video.currentTime<this.clip.start){this.video.currentTime=this.clip.start;}
      if(this.video.currentTime>=this.clip.end){this.video.pause();if(this.video.currentTime>this.clip.end)this.video.currentTime=this.clip.end;}
      this.render();
    }
    render(){
      if(!this.clip)return;
      const elapsed=Math.max(0,Math.min(this.duration,this.video.currentTime-this.clip.start));
      this.range.value=elapsed;this.range.setAttribute('aria-valuetext',`${clock(elapsed)} of ${clock(this.duration)} in this clip`);
      this.display.textContent=`${clock(elapsed)} / ${clock(this.duration)}`;
      const label=this.video.paused?'▶ Play':'Ⅱ Pause';this.playButton.textContent=label;this.playButton.setAttribute('aria-label',this.video.paused?'Play this clip':'Pause this clip');
      if(this.muteButton){this.muteButton.textContent=this.video.muted?'Unmute':'Mute';this.muteButton.setAttribute('aria-pressed',String(this.video.muted));}
    }
  }
  window.ClipPlayback=ClipPlayback;
})();
