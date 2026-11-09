(() => {
  const $=id=>document.getElementById(id);
  const time=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
  class ClipTimeline {
    constructor({onConfirm,onCancel,onError}){
      this.onConfirm=onConfirm;this.onCancel=onCancel;this.onError=onError;this.pending=Promise.resolve();this.dirty=false;
      this.video=$('segmentVideo');this.rail=$('segmentRail');this.scrubber=$('segmentScrubber');
      this.video.addEventListener('timeupdate',()=>{
        if(this.previewEnd!==null&&this.previewEnd!==undefined&&this.video.currentTime>=this.previewEnd){this.video.pause();this.previewEnd=null;}
        if(!this.scrubbing)this.scrubber.value=this.video.currentTime;
        this.position();
      });
      this.scrubber.addEventListener('input',()=>{this.previewEnd=null;this.video.pause();this.video.currentTime=Number(this.scrubber.value);this.position();});
      this.scrubber.addEventListener('pointerdown',()=>this.scrubbing=true);
      for(const event of ['pointerup','pointercancel','change'])this.scrubber.addEventListener(event,()=>this.scrubbing=false);
      this.rail.addEventListener('click',e=>{
        if(e.target.closest('.cut-handle'))return;
        const rect=this.rail.getBoundingClientRect();this.seek((e.clientX-rect.left)/rect.width*this.project.duration);
      });
      $('splitHere').onclick=()=>this.split();$('removeCut').onclick=()=>this.remove();$('undoCut').onclick=()=>this.undo();
      $('cutPosition').onchange=()=>{if(this.selected){try{this.remember();this.cuts[this.selected]=Number($('cutPosition').value);this.cuts=clipModel.normalize(this.cuts,this.project.duration);this.render();this.save();}catch(e){this.cuts=this.history.pop();this.render();this.onError(e.message);}}};
      $('confirmClips').onclick=async()=>{
        const button=$('confirmClips');button.disabled=true;
        try{
          await this.flush();const plan=clipModel.plan(this.project,this.cuts);
          if(plan.affectedCount&&!confirm(`These boundaries change ${plan.affectedCount} annotated or reviewed clips. Their annotations will be cleared; unchanged clips keep their labels. Continue?`))return;
          const p=await frameStore.confirmCuts(this.project.id,this.cuts,{allowReset:plan.affectedCount>0});
          this.video.pause();await this.onConfirm(p);
        }catch(e){this.onError(e.message);}finally{button.disabled=false;}
      };
      $('cancelSegmentation').onclick=async()=>{try{await this.flush();this.video.pause();await this.onCancel(this.project);}catch(e){this.onError(e.message);}};
      document.addEventListener('keydown',e=>{
        if($('segmenter').hidden||e.target.closest('input,textarea,select')||document.querySelector('dialog[open]'))return;
        if(e.key.toLowerCase()==='s'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();this.split();}
      });
    }
    async open(project){
      this.project=project;this.cuts=clipModel.normalize(project.segmentCuts||[0,project.duration],project.duration);
      this.history=[];this.selected=null;this.previewEnd=null;this.dirty=false;
      $('segmentSaveStatus').textContent='Saved';
      $('segmentName').textContent=project.name;this.scrubber.max=project.duration;this.scrubber.value=0;
      $('segmentDuration').textContent=time(project.duration);$('cancelSegmentation').textContent=project.status==='ready'?'Back to labeling':'Back to projects';
      this.render();await frameStore.attachVideo(this.video,project.id);this.video.pause();this.video.currentTime=0;this.position();
    }
    remember(){this.history.push([...this.cuts]);if(this.history.length>100)this.history.shift();}
    seek(t){this.previewEnd=null;this.video.pause();this.video.currentTime=Math.min(this.project.duration,Math.max(0,t));this.scrubber.value=this.video.currentTime;this.position();}
    position(){
      const t=Number(this.scrubber.value)||0;$('segmentCurrent').textContent=time(t);
      $('splitHere').disabled=!this.project||this.cuts.length>clipModel.maxClips||this.cuts.some(c=>Math.abs(c-t)<clipModel.minClip);
      $('splitHere').textContent=`✂ Split at ${time(t)}`;
    }
    split(){
      if($('splitHere').disabled)return;
      this.remember();const t=Number(Number(this.scrubber.value).toFixed(6));this.cuts.push(t);this.cuts.sort((a,b)=>a-b);this.selected=this.cuts.indexOf(t);this.render();this.save();
    }
    remove(){if(!this.selected)return;this.remember();this.cuts.splice(this.selected,1);this.selected=null;this.render();this.save();}
    undo(){if(!this.history.length)return;this.cuts=this.history.pop();this.selected=null;this.render();this.save();}
    render(rebuild=true){
      const duration=this.project.duration;
      if(rebuild){
        this.rail.replaceChildren();
        for(let i=0;i<this.cuts.length-1;i++){const region=document.createElement('div');region.className='clip-region';region.dataset.index=i;this.rail.append(region);}
        for(let i=1;i<this.cuts.length-1;i++){
          const handle=document.createElement('button');handle.type='button';handle.className='cut-handle';handle.dataset.index=i;handle.setAttribute('role','slider');handle.tabIndex=0;
          handle.addEventListener('pointerdown',e=>{
            e.preventDefault();this.selected=i;this.remember();this.video.pause();handle.setPointerCapture(e.pointerId);this.dragging=true;this.render(false);
          });
          handle.addEventListener('pointermove',e=>{
            if(!this.dragging||!handle.hasPointerCapture(e.pointerId))return;
            const rect=this.rail.getBoundingClientRect(),t=(e.clientX-rect.left)/rect.width*duration;
            this.cuts[i]=Number(Math.min(this.cuts[i+1]-clipModel.minClip,Math.max(this.cuts[i-1]+clipModel.minClip,t)).toFixed(6));
            this.seek(this.cuts[i]);this.render(false);this.dirty=true;$('segmentSaveStatus').textContent='Unsaved…';
          });
          const end=e=>{if(!this.dragging)return;this.dragging=false;if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);this.save();};
          handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
          handle.addEventListener('keydown',e=>{
            if(!['ArrowLeft','ArrowRight','Delete','Backspace'].includes(e.key))return;e.preventDefault();this.selected=i;
            if(['Delete','Backspace'].includes(e.key)){this.remove();return;}
            this.remember();const step=(e.shiftKey?1:.1)*(e.key==='ArrowLeft'?-1:1);
            this.cuts[i]=Number(Math.min(this.cuts[i+1]-clipModel.minClip,Math.max(this.cuts[i-1]+clipModel.minClip,this.cuts[i]+step)).toFixed(6));this.seek(this.cuts[i]);this.render(false);this.save();
          });
          handle.addEventListener('click',e=>{e.stopPropagation();this.selected=i;this.seek(this.cuts[i]);this.render(false);});this.rail.append(handle);
        }
      }
      for(const region of this.rail.querySelectorAll('.clip-region')){
        const i=Number(region.dataset.index);region.style.left=`${this.cuts[i]/duration*100}%`;region.style.width=`${(this.cuts[i+1]-this.cuts[i])/duration*100}%`;region.textContent=`${i+1}`;
      }
      for(const handle of this.rail.querySelectorAll('.cut-handle')){
        const i=Number(handle.dataset.index);handle.style.left=`${this.cuts[i]/duration*100}%`;handle.classList.toggle('selected',this.selected===i);
        handle.setAttribute('aria-label',`Cut ${i} at ${time(this.cuts[i])}`);handle.setAttribute('aria-valuemin',this.cuts[i-1]+clipModel.minClip);handle.setAttribute('aria-valuemax',this.cuts[i+1]-clipModel.minClip);handle.setAttribute('aria-valuenow',this.cuts[i]);
        handle.title=`Drag to adjust · ${time(this.cuts[i])}`;
      }
      $('segmentCount').textContent=`${this.cuts.length-1} clips · Entire video covered`;
      $('confirmClips').textContent=`Confirm ${this.cuts.length-1} clips → Annotate`;
      $('removeCut').disabled=!this.selected;$('undoCut').disabled=!this.history.length;
      $('cutTools').hidden=!this.selected;$('cutPosition').value=this.selected?this.cuts[this.selected]:'';
      $('segmentList').replaceChildren(...this.cuts.slice(0,-1).map((start,i)=>{
        const row=document.createElement('button');row.type='button';row.className='segment-list-item';
        const label=document.createElement('strong');label.textContent=`Clip ${String(i+1).padStart(2,'0')}`;
        const range=document.createElement('span');range.textContent=`${time(start)} – ${time(this.cuts[i+1])}`;
        const length=document.createElement('small');length.textContent=`${(this.cuts[i+1]-start).toFixed(2)} s`;
        const play=document.createElement('span');play.className='segment-play';play.textContent='▶ Preview';row.append(label,range,length,play);
        row.onclick=()=>{this.seek(start);this.previewEnd=this.cuts[i+1];this.video.play().catch(e=>this.onError(e.message));};return row;
      }));this.position();
    }
    save(){
      const cuts=[...this.cuts],id=this.project.id;this.dirty=true;$('segmentSaveStatus').textContent='Saving…';
      this.pending=this.pending.catch(()=>{}).then(()=>frameStore.saveCuts(id,cuts)).then(()=>{
        if(id===this.project.id&&JSON.stringify(cuts)===JSON.stringify(this.cuts)){this.dirty=false;$('segmentSaveStatus').textContent='Saved';}
      }).catch(e=>{$('segmentSaveStatus').textContent='Save failed';this.onError(e.message);throw e;});
      this.pending.catch(()=>{});return this.pending;
    }
    async flush(){if(this.dirty)await this.save();else await this.pending;}
  }
  window.ClipTimeline=ClipTimeline;
})();
