/* Three-row doctor workspace, following the supplied PDF layout. */
(() => {
  const $=id=>document.getElementById(id),round=t=>Number(t.toFixed(6));
  const time=t=>`${Math.floor(t/3600).toString().padStart(2,'0')}:${Math.floor(t%3600/60).toString().padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
  class DoctorWorkspace {
    constructor(callbacks){
      Object.assign(this,callbacks);this.pending=Promise.resolve();this.unsavedMedia={};this.dirty=false;this.points=[];this.audioURLs=[];this.version=0;
      this.source=$('dwSource');this.player=$('dwClip');this.regionVideo=$('dwRegionVideo');this.canvas=$('dwCanvas');
      this.clipPlayback=new ClipPlayback(this.player,{range:$('dwClipScrub'),play:$('dwClipPlay'),display:$('dwClipTiming'),mute:$('dwClipMute'),fullscreen:$('dwClipFullscreen'),shell:$('dwClipShell'),onError:this.onError});
      this.regionPlayback=new ClipPlayback(this.regionVideo,{range:$('dwRegionScrub'),play:$('dwRegionPlay'),display:$('dwRegionTime'),mute:$('dwRegionMute'),fullscreen:$('dwRegionFullscreen'),shell:$('dwRegionShell'),onError:this.onError});
      this.anchors=new PolygonAnchors(this.canvas,{getShapes:()=>this.anchorShapes(),onPreview:()=>this.draw(),onCommit:drag=>this.commitAnchor(drag),onError:e=>this.error(e)});
      this.bind();
    }
    error(e){this.onError(e.message||String(e));}
    bind(){
      const action=fn=>async()=>{try{await fn();}catch(e){this.error(e);}};
      $('dwBack').onclick=this.onBack;$('dwSubmit').onclick=this.onSubmit;
      $('dwDownload').onclick=action(async()=>{const button=$('dwDownload');button.disabled=true;button.textContent='Preparing download…';try{await this.flush();await frameStore.exportData(this.project.id,'zip',false);this.onError('Downloaded to your computer, including a backup for continuing later.');}finally{button.disabled=false;button.textContent='Download to local';}});
      $('dwAdd').onclick=()=>{this.start=null;this.end=null;this.cutStatus();this.source.focus();};
      $('dwStart').onclick=()=>{this.start=round(this.source.currentTime);this.cutStatus();};
      $('dwEnd').onclick=()=>{this.end=round(this.source.currentTime);this.cutStatus();};
      $('dwDone').onclick=action(async()=>{
        const button=$('dwDone');button.disabled=true;
        try{await this.flush();this.project=await frameStore.addClip(this.project.id,this.start,this.end);this.onProject(this.project);this.start=this.end=null;this.cutStatus();await this.select(this.project.frames.at(-1).clip_id,true);}
        finally{this.cutStatus();}
      });
      $('dwDelete').onclick=action(async()=>{
        if(!this.clip)return;await this.flush();
        if(!confirm(`Delete ${this.clip.clip_id}, its recordings and its region labels? Other clips are preserved.`))return;
        this.project=await frameStore.deleteClip(this.project.id,this.clip.clip_id);this.onProject(this.project);await this.select(this.project.frames[0]?.clip_id,true);
      });
      $('dwSelect').onchange=action(async()=>{try{await this.select($('dwSelect').value);}finally{$('dwSelect').value=this.clip?.clip_id||'';}});
      this.source.addEventListener('timeupdate',()=>{$('dwScrub').value=this.source.currentTime;$('dwSourceTime').textContent=`${time(this.source.currentTime)} / ${time(this.project?.duration||0)}`;});
      $('dwScrub').oninput=()=>{this.source.pause();this.source.currentTime=Number($('dwScrub').value);};
      document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{
        const key=b.dataset.step,x=Number($('dwCustomStep').value);if(key.includes('custom')&&(!Number.isFinite(x)||x<=0))return this.onError('Enter a positive number of seconds for x.');const delta=key.includes('custom')?(key.startsWith('-')?-x:x):Number(key);
        if(!Number.isFinite(delta)||!delta)return this.onError('Enter a positive number of seconds for x.');
        this.source.currentTime=Math.max(0,Math.min(this.project.duration,this.source.currentTime+delta));
      });
      for(const video of [this.source,this.player,this.regionVideo])video.addEventListener('play',()=>{for(const other of [this.source,this.player,this.regionVideo])if(video!==other)other.pause();});
      $('dwSave').onclick=action(async()=>{const button=$('dwSave');button.disabled=true;try{await this.flush();const version=this.version;await this.persist(true);$('dwSaveStatus').textContent=version===this.version?'Done!':'Not saved';this.renderGallery();}finally{button.disabled=false;}});
      for(const [name,type]of [['Goal','goal'],['Avoid','avoid']]){
        $('dw'+name+'Go').onclick=action(()=>this.beginRegion(type));
        $('dw'+name+'Redo').onclick=action(async()=>{
          if(!this.state?.region)return;if(this.points.length&&this.mode!==type)throw Error('Save or Redo the other color polygon first.');
          if((this.state.region[type].length||this.points.length)&&!confirm(`Clear ${type} areas on this clip's selected frame and draw again?`))return;
          this.points=[];this.mode=type;this.state.region[type]=[];this.changed();this.draw();await this.persist();$('dwRegionStatus').textContent=`${name} areas cleared. Click points to redraw.`;
        });
        $('dw'+name+'Save').onclick=action(()=>this.saveRegion(type));
      }
      this.canvas.addEventListener('click',e=>{
        if(this.anchors.suppressClick){this.anchors.suppressClick=false;return;}
        if(!this.image||!this.mode)return this.onError('Choose a frame and click Label target or Label avoid first.');
        const rect=this.canvas.getBoundingClientRect();if(this.points.length>=200)return this.onError('Maximum 200 points per polygon.');
        this.points.push([Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))]);this.draw();
        $('dwRegionStatus').textContent=`${this.mode==='goal'?'Goal':'Avoid'} polygon: ${this.points.length} points. Click its matching Save button to finish.`;
      });
      this.canvas.addEventListener('keydown',e=>{if(e.key==='Backspace'&&this.points.length&&!this.anchors.drag){e.preventDefault();this.points.pop();this.draw();}});
    }
    async open(project){
      this.project=project;this.clip=null;this.state=null;this.dirty=false;this.unsavedMedia={};this.points=[];this.start=this.end=null;
      $('dwName').textContent=project.name;$('dwMeta').textContent=`${project.annotator} · ${time(project.duration)} · Local workspace`;$('dwScrub').max=project.duration;
      await frameStore.attachVideo(this.source,project.id);this.cutStatus();
      await this.select(project.frames.find(c=>!c.reviewed)?.clip_id||project.frames[0]?.clip_id,true);
    }
    cutStatus(){
      const valid=Number.isFinite(this.start)&&Number.isFinite(this.end)&&this.end-this.start>=.25&&this.start>=0&&this.end<=this.project.duration;
      $('dwDone').disabled=!valid;
      $('dwCutStatus').textContent=`Start: ${this.start===null?'not set':time(this.start)} · End: ${this.end===null?'not set':time(this.end)}${valid?` · ${(this.end-this.start).toFixed(2)} s · Ready for Done!`:' · Set both times (minimum 0.25 s). Overlap is allowed.'}`;
    }
    async select(id,skipFlush=false){
      if(!skipFlush)await this.flush();
      this.clipPlayback.clear();this.regionPlayback.clear();this.clip=this.project.frames.find(c=>c.clip_id===id)||null;this.state=null;this.points=[];this.mode=null;this.image=null;this.dirty=false;this.version++;$('dwRegionStatus').textContent='';$('dwRegionScrub').value=0;
      for(const url of this.audioURLs)URL.revokeObjectURL(url);this.audioURLs=[];
      $('dwAnnotation').hidden=!this.clip;$('dwEmpty').hidden=!!this.clip;$('dwDelete').disabled=!this.clip;this.renderGallery();
      if(!this.clip){$('dwRegions').hidden=true;return;}
      const legacy=this.clip.labels[0];this.state=structuredClone(this.clip.annotation||{action:legacy?.Y?.action||'',tool:legacy?.X?.instrument||'',tissue:legacy?.T?.anatomy||''});
      this.updateClipNames();
      $('dwSaveStatus').textContent=this.clip.reviewed?'Done!':'Not saved';$('dwLocalStatus').textContent='Changes stay on this device.';
      for(const key of ['action','tool','tissue'])this.renderChoices(key);
      await frameStore.attachVideo(this.player,this.project.id);this.clipPlayback.setClip(this.clip);
      await this.renderAudio('goal');await this.renderAudio('outcome');await this.regionsVisible();
    }
    clipName(clip,index){
      const value=clip===this.clip&&this.state?this.state.action:(clip.annotation?.action||clip.labels?.[0]?.Y?.action||'');
      const action=typeof value==='string'?value.trim():'';
      return `Clip ${index+1}${action?` · ${action}`:''}${clip.reviewed?' ✓':''}`;
    }
    updateClipNames(){
      const options=new Map([...$('dwSelect').options].map(o=>[o.value,o]));
      if(this.clip){const name=this.clipName(this.clip,this.project.frames.indexOf(this.clip));$('dwClipTitle').textContent=name;$('dwRegionTitle').textContent=name;}
      for(const [index,clip]of this.project.frames.entries()){
        const name=this.clipName(clip,index),option=options.get(clip.clip_id),card=$('dwGallery').children[index];
        if(option)option.textContent=name;
        if(card){card.querySelector('strong').textContent=name;card.setAttribute('aria-label',`Select ${name}`);}
      }
      $('dwClipCount').textContent=`${this.project.frames.length} clips · ${this.project.frames.filter(c=>c.reviewed).length} saved`;
    }
    renderGallery(){
      const scroll=$('dwGallery').scrollTop;this.observer?.disconnect();
      const picker=$('dwSelect');picker.replaceChildren();
      if(!this.project.frames.length){const o=document.createElement('option');o.textContent='No clips yet';o.value='';picker.append(o);}
      $('dwGallery').replaceChildren(...this.project.frames.map((clip,index)=>{
        const option=document.createElement('option');option.value=clip.clip_id;option.textContent=this.clipName(clip,index);picker.append(option);
        const card=document.createElement('div');card.className='dw-thumb'+(this.clip?.clip_id===clip.clip_id?' selected':'');card.role='button';card.tabIndex=0;card.setAttribute('aria-label',`Select ${this.clipName(clip,index)}`);
        const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='metadata';video.dataset.start=clip.start;video.dataset.end=clip.end;
        const title=document.createElement('strong');title.textContent=this.clipName(clip,index);const range=document.createElement('small');range.textContent=`${time(clip.start)}–${time(clip.end)}`;card.append(video,title,range);
        const select=async()=>{try{await this.select(clip.clip_id);}catch(e){this.error(e);}};card.onclick=select;card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}};
        card.onmouseenter=()=>{if(video.src)video.play().catch(()=>{});};card.onmouseleave=()=>video.pause();video.ontimeupdate=()=>{if(video.currentTime>=clip.end){video.pause();video.currentTime=clip.start;}};
        return card;
      }));picker.value=this.clip?.clip_id||'';$('dwGallery').scrollTop=scroll;$('dwClipCount').textContent=`${this.project.frames.length} clips · ${this.project.frames.filter(c=>c.reviewed).length} saved`;
      const projectId=this.project.id;
      if(typeof IntersectionObserver!=='undefined'){
        this.observer=new IntersectionObserver(entries=>{for(const item of entries)if(item.isIntersecting){const v=item.target;this.observer.unobserve(v);frameStore.attachVideo(v,projectId).then(()=>{if(v.isConnected)v.currentTime=Number(v.dataset.start);}).catch(e=>this.error(e));}},{root:$('dwGallery'),rootMargin:'80px'});
        $('dwGallery').querySelectorAll('video').forEach(v=>this.observer.observe(v));
      }
    }
    choices(key){
      const values=new Set(doctorModel.options[key]);
      for(const clip of this.project.frames){const value=clip.annotation?.[key];if(value)values.add(value);}
      for(const value of this.project.vocabulary?.[key]||[])values.add(value);
      if(this.state[key])values.add(this.state[key]);return [...values];
    }
    renderChoices(key){
      const container=$('dw'+key[0].toUpperCase()+key.slice(1));container.replaceChildren();
      for(const value of this.choices(key)){const button=document.createElement('button');button.textContent=value;button.setAttribute('aria-pressed',String(this.state[key]===value));button.onclick=async()=>{
        if(key==='action'&&this.points.length)return this.onError('Save or Redo your unfinished polygon first.');
        this.state[key]=value;this.changed();this.renderChoices(key);if(key==='action')try{await this.regionsVisible();}catch(e){this.error(e);}
      };container.append(button);}
      const other=document.createElement('button');other.textContent='Other +';other.onclick=()=>{
        if(container.querySelector('form'))return;
        const form=document.createElement('form');form.className='dw-other-form';const input=document.createElement('input');input.maxLength=200;input.placeholder=`Add a ${key}`;input.setAttribute('aria-label',`Custom ${key}`);input.required=true;
        const add=document.createElement('button');add.textContent='Add option';const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.onclick=()=>form.remove();
        form.append(input,add,cancel);form.onsubmit=async e=>{e.preventDefault();const text=input.value.trim();if(!text)return;try{add.disabled=true;const p=await frameStore.saveVocabulary(this.project.id,key,text);this.project.vocabulary=p.vocabulary;this.onProject(this.project);this.renderChoices(key);}catch(e){add.disabled=false;this.error(e);}};container.append(form);input.focus();
      };container.append(other);
    }
    changed(){
      this.dirty=true;this.version++;this.clip.reviewed=false;this.project.completed=false;this.onProject(this.project);$('dwSaveStatus').textContent='Not saved';$('dwLocalStatus').textContent='Saving draft locally…';this.updateClipNames();
      clearTimeout(this.timer);this.timer=setTimeout(()=>this.persist().catch(e=>this.error(e)),500);
    }
    persist(complete=false,blobs={}){
      clearTimeout(this.timer);if(!this.clip)return Promise.resolve();
      Object.assign(this.unsavedMedia,blobs);const media={...this.unsavedMedia};
      const id=this.project.id,clipId=this.clip.clip_id,value=structuredClone(this.state),version=this.version;
      this.pending=this.pending.catch(()=>{}).then(()=>frameStore.saveDoctor(id,clipId,value,media,complete)).then(result=>{
        if(this.project.id===id&&this.clip?.clip_id===clipId){
          for(const key of Object.keys(media))if(this.unsavedMedia[key]===media[key])delete this.unsavedMedia[key];
          this.clip.annotation=result;this.clip.reviewed=complete&&version===this.version;this.clip.updated_at=new Date().toISOString();this.project.completed=false;
          if(version===this.version){this.state=result;this.dirty=false;$('dwLocalStatus').textContent=complete?'Saved on this device.':'Draft saved on this device. Click Save when finished.';}
          this.onProject(this.project);this.updateClipNames();
        }
        return result;
      }).catch(e=>{this.dirty=true;$('dwLocalStatus').textContent='Local save failed. Please retry.';throw e;});this.pending.catch(()=>{});return this.pending;
    }
    async flush(){
      if(this.recording||this.startingRecording)throw Error('Stop the recording before leaving this clip.');
      if(this.capturing)throw Error('Wait for the frame capture to finish.');
      if(this.anchors?.drag)throw Error('Release the point to finish moving it first.');
      if(this.points.length)throw Error('Save the current polygon, or use Redo before leaving this clip.');
      if(this.dirty)await this.persist();else await this.pending;
    }
    async renderAudio(type){
      const wrap=$('dw'+(type==='goal'?'Goal':'Outcome')+'Audio');wrap.replaceChildren();
      const record=document.createElement('button');record.textContent=`● Record ${type}`;record.type='button';record.onclick=()=>this.startRecording(type,record).catch(e=>this.error(e));wrap.append(record);
      const asset=this.state[`${type}_audio`],pending=this.unsavedMedia[type];
      if(asset||pending){const blob=pending||await frameStore.media(this.project.id,asset.file_name);if(blob){const audio=document.createElement('audio');audio.controls=true;const url=URL.createObjectURL(blob);this.audioURLs.push(url);audio.src=url;wrap.append(audio);const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=async()=>{try{if(this.recording)return this.onError('Stop recording first.');this.changed();await this.persist(false,{[type]:null});await this.renderAudio(type);}catch(e){this.error(e);}};wrap.append(remove);}}
      const note=document.createElement('span');note.className='dw-audio-hint';note.textContent='Record audio only · Up to 3 minutes';wrap.append(note);
    }
    async startRecording(type,button){
      if(this.recording||this.startingRecording)throw Error('Finish the current recording first.');
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('Audio recording is unavailable. Use a recent Chrome, Edge or Safari browser and allow microphone access.');
      this.startingRecording=true;let stream;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
        const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined),chunks=[];let failure;
        this.recording=recorder;button.textContent='■ Stop recording';button.classList.add('recording');
        button.onclick=()=>{if(recorder.state!=='inactive')recorder.stop();};
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recorder.onerror=e=>{failure=e.error||Error('Recording failed.');if(recorder.state!=='inactive')recorder.stop();};
        recorder.onstop=async()=>{
          clearTimeout(this.recordTimer);stream.getTracks().forEach(t=>t.stop());
          try{if(failure)throw failure;const blob=new Blob(chunks,{type:recorder.mimeType||mime||'audio/webm'});this.changed();await this.persist(false,{[type]:blob});}
          catch(e){this.error(e);}finally{this.recording=null;button.classList.remove('recording');try{await this.renderAudio(type);}catch(e){this.error(e);}}
        };
        recorder.start();this.recordTimer=setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},180000);
      }catch(e){stream?.getTracks().forEach(t=>t.stop());this.recording=null;throw Error(e.name==='NotAllowedError'?'Microphone permission was denied. Allow microphone access for this website and try Record again.':e.message);}
      finally{this.startingRecording=false;}
    }
    async regionsVisible(){
      const show=doctorModel.needsRegions(this.state.action);$('dwRegions').hidden=!show;if(!show){this.regionVideo.pause();return;}
      await frameStore.attachVideo(this.regionVideo,this.project.id);this.regionPlayback.setClip(this.clip,this.state.region?.timestamp||0);
      if(this.state.frame_image){const blob=await frameStore.media(this.project.id,this.state.frame_image.file_name);if(blob)await this.loadImage(blob);}
      $('dwCanvasEmpty').hidden=!!this.image;this.draw();
    }
    async loadImage(blob){
      const image=new Image(),url=URL.createObjectURL(blob);try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Could not read the saved annotation frame.'));image.src=url;});this.image=image;this.canvas.width=image.naturalWidth;this.canvas.height=image.naturalHeight;$('dwCanvasEmpty').hidden=true;this.draw();}finally{URL.revokeObjectURL(url);}
    }
    async seek(video,t){
      video.pause();if(Math.abs(video.currentTime-t)>.001)await new Promise((resolve,reject)=>{let timer;const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',ok);video.removeEventListener('error',fail);};const ok=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error('Could not read the selected video frame.'));};video.addEventListener('seeked',ok);video.addEventListener('error',fail);timer=setTimeout(fail,15000);video.currentTime=t;});
      if(video.readyState<2)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{video.removeEventListener('loadeddata',done);reject(Error('Video frame is not ready.'));},15000);const done=()=>{clearTimeout(timer);resolve();};video.addEventListener('loadeddata',done,{once:true});});
    }
    async beginRegion(type){
      if(this.anchors.drag)throw Error('Release the point to finish moving it first.');
      if(this.capturing)return;this.capturing=true;
      try{return await this.captureRegion(type);}finally{this.capturing=false;}
    }
    async captureRegion(type){
      if(this.points.length)throw Error('Save or Redo the current polygon before switching drawing modes.');
      const t=Math.min(clipModel.clipDuration(this.clip),Math.max(0,this.regionVideo.currentTime-this.clip.start));
      if(this.state.region&&this.image&&Math.abs(t-this.state.region.timestamp)<.05){this.mode=type;this.draw();return;}
      if(this.state.region&&(this.state.region.goal.length||this.state.region.avoid.length)&&!confirm('Each clip has one annotation frame. Selecting a new frame replaces BOTH goal and avoid areas. Continue?'))return;
      const captureTime=Math.min(this.clip.end-.001,this.clip.start+t);await this.seek(this.regionVideo,captureTime);
      const canvas=document.createElement('canvas');canvas.width=this.regionVideo.videoWidth;canvas.height=this.regionVideo.videoHeight;canvas.getContext('2d').drawImage(this.regionVideo,0,0);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));if(!blob)throw Error('Could not capture the frame.');
      this.state.region={timestamp:round(captureTime-this.clip.start),width:canvas.width,height:canvas.height,goal:[],avoid:[]};this.mode=type;this.changed();await this.persist(false,{frame:blob});await this.loadImage(blob);
      $('dwRegionStatus').textContent=`${type==='goal'?'Goal':'Avoid'} mode · Click at least 3 points. Then Save ${type} areas.`;
    }
    async saveRegion(type){
      if(this.anchors.drag)throw Error('Release the point to finish moving it first.');
      if(!this.image||!this.state.region)throw Error('Choose a frame and click Label target or Label avoid first.');
      if(this.points.length){if(this.mode!==type)throw Error('Use the Save button matching the polygon color.');const candidate=structuredClone(this.state);candidate.region[type].push(structuredClone(this.points));doctorModel.validate(candidate,clipModel.clipDuration(this.clip));this.state=candidate;this.points=[];this.changed();}
      await this.persist();this.draw();$('dwRegionStatus').textContent=`${type==='goal'?'Goal':'Avoid'} areas saved on this device.`;
    }
    anchorShapes(){
      if(!this.image)return [];
      const shapes=[];
      for(const type of ['goal','avoid'])for(const [polygon,points]of (this.state?.region?.[type]||[]).entries())shapes.push({kind:'saved',type,polygon,points});
      if(this.points.length)shapes.push({kind:'draft',type:this.mode,polygon:-1,points:this.points});
      return shapes;
    }
    async commitAnchor(drag){
      if(drag.kind==='draft'){
        if(!this.points[drag.vertex])return;
        this.points[drag.vertex]=drag.point;
        $('dwRegionStatus').textContent='Point moved. Continue adding points or save this area.';
      }else{
        const candidate=structuredClone(this.state),points=candidate.region?.[drag.type]?.[drag.polygon];
        if(!points?.[drag.vertex])return;
        points[drag.vertex]=drag.point;
        doctorModel.validate(candidate,clipModel.clipDuration(this.clip));
        this.state=candidate;this.changed();this.draw();await this.persist();
        $('dwRegionStatus').textContent=`${drag.type==='goal'?'Target':'Avoid'} point moved and saved locally.`;
      }
      this.draw();
    }
    draw(){
      const c=this.canvas.getContext('2d'),w=this.canvas.width,h=this.canvas.height,scale=w/(this.canvas.getBoundingClientRect().width||w);c.clearRect(0,0,w,h);if(!this.image)return;c.drawImage(this.image,0,0,w,h);
      const polygon=(points,type,draft=false)=>{if(!points.length)return;c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x*w,y*h):c.moveTo(x*w,y*h));if(points.length>=3)c.closePath();c.fillStyle=type==='goal'?'rgba(105,160,125,.55)':'rgba(239,139,151,.55)';c.strokeStyle=type==='goal'?'#2a7047':'#b73351';c.lineWidth=1.5*scale;if(points.length>=3)c.fill();c.stroke();for(const [x,y]of points){c.beginPath();c.arc(x*w,y*h,5*scale,0,Math.PI*2);c.fillStyle=draft?'#fff':c.strokeStyle;c.fill();c.stroke();}};
      for(const type of ['goal','avoid'])for(const [index,points]of (this.state?.region?.[type]||[]).entries())polygon(this.anchors.preview(points,type,'saved',index),type);polygon(this.anchors.preview(this.points,this.mode,'draft',-1),this.mode,true);
    }
  }
  window.DoctorWorkspace=DoctorWorkspace;
})();
