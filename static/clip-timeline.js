(() => {
  const $=id=>document.getElementById(id);
  const time=t=>`${Math.floor(t/3600).toString().padStart(2,'0')}:${Math.floor(t%3600/60).toString().padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
  class ClipTimeline {
    constructor({onConfirm,onCancel,onError}){
      Object.assign(this,{onConfirm,onCancel,onError,dirty:false});this.video=$('segmentVideo');
      this.video.addEventListener('timeupdate',()=>{if(this.previewEnd!==null&&this.video.currentTime>=this.previewEnd){this.video.pause();this.previewEnd=null;}$('segmentScrubber').value=this.video.currentTime;$('segmentCurrent').textContent=time(this.video.currentTime);});
      $('segmentScrubber').oninput=()=>{this.video.pause();this.previewEnd=null;this.video.currentTime=Number($('segmentScrubber').value);};
      for(const side of ['Start','End']){
        const sync=value=>{$('clip'+side).value=value;$(side.toLowerCase()+'Range').value=value;this.summary();};
        $('clip'+side).oninput=e=>sync(e.target.value);
        $(side.toLowerCase()+'Range').oninput=e=>{sync(e.target.value);this.video.pause();this.video.currentTime=Number(e.target.value);};
        $('set'+side).onclick=()=>sync(this.video.currentTime.toFixed(2));
      }
      $('previewRange').onclick=()=>{if(!this.valid())return this.onError('Choose a valid start and end (at least 0.25 seconds).');this.video.currentTime=Number($('clipStart').value);this.previewEnd=Number($('clipEnd').value);this.video.play().catch(e=>onError(e.message));};
      $('cancelSegmentation').onclick=()=>{this.video.pause();this.onCancel(this.project);};
      $('confirmClips').onclick=async()=>{
        const button=$('confirmClips');button.disabled=true;
        try{const p=await frameStore.addClip(this.project.id,Number($('clipStart').value),Number($('clipEnd').value));this.video.pause();await this.onConfirm(p);}catch(e){onError(e.message);}finally{this.summary();}
      };
    }
    valid(){const a=Number($('clipStart').value),b=Number($('clipEnd').value);return $('clipStart').value!==''&&$('clipEnd').value!==''&&Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b<=this.project.duration&&b-a>=.25;}
    summary(){const a=Number($('clipStart').value),b=Number($('clipEnd').value);$('rangeSummary').textContent=this.valid()?`${time(a)} → ${time(b)} · ${(b-a).toFixed(2)} seconds · Overlap allowed`:'Choose a start and a later end within the video (minimum 0.25 seconds).';$('confirmClips').disabled=!this.valid();}
    async open(project){
      this.project=project;this.previewEnd=null;$('segmentName').textContent=project.name;$('segmentDuration').textContent=time(project.duration);
      for(const id of ['segmentScrubber','startRange','endRange','clipStart','clipEnd'])$(id).max=project.duration;
      const last=project.frames.at(-1),start=Math.min(last?.end||0,Math.max(0,project.duration-.25));
      $('clipStart').value=$('startRange').value=start;$('clipEnd').value=$('endRange').value=Math.min(project.duration,start+10);
      $('cancelSegmentation').textContent=project.frames.length?'Back to labels':'Back to projects';
      await frameStore.attachVideo(this.video,project.id);this.video.currentTime=start;this.summary();
    }
    async flush(){}
  }
  window.ClipTimeline=ClipTimeline;
})();
