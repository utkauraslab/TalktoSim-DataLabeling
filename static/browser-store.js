/* Browser-local storage, video sampling and portable dataset exports. No upload server. */
(() => {
  const now = () => new Date().toISOString();
  const copy = value => structuredClone(value);
  const jobs = new Map(), imageURLs = new Set(),videoURLs=new Map();
  const groups = {X:['instrument'], Y:['action','direction'], T:['anatomy','region'],
    Z:['intended_goal','goal_type','source'], O:['observed_effect','goal_achieved','source']};
  let database;
  const ready = new Promise((resolve, reject) => {
    const request = indexedDB.open('talktosim-framelab-v1', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains('projects'))db.createObjectStore('projects', {keyPath:'id'});
      if(!db.objectStoreNames.contains('images')){
        const images = db.createObjectStore('images', {keyPath:'key'});
        images.createIndex('project_id', 'project_id');
      }
      if(!db.objectStoreNames.contains('videos'))db.createObjectStore('videos',{keyPath:'id'});
    };
    request.onsuccess = () => { database = request.result; database.onversionchange = () => database.close(); resolve(); };
    request.onerror = () => reject(Error('Browser storage is unavailable. Enable site storage or use a regular browser window.'));
  });
  async function run(store, mode, action) {
    await ready;
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode), request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('Could not save to browser storage.'));
    });
  }
  const get = id => run('projects', 'readonly', store => store.get(id));
  const put = project => run('projects', 'readwrite', store => store.put(project));
  async function update(id, mutate) {
    await ready;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('projects', 'readwrite'), store = tx.objectStore('projects');
      let result, failure;
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          if (!request.result) throw Error('Project not found on this browser.');
          result = mutate(request.result); store.put(request.result);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || Error('Could not save this annotation.'));
    });
  }
  async function readProject(id) {
    let p = jobs.has(id) ? copy(jobs.get(id)) : await get(id);
    if (!p) throw Error('Project not found on this browser.');
    if (p.status === 'processing' && !jobs.has(id)) {
      const locks = navigator.locks ? await navigator.locks.query() : null;
      const active = locks ? locks.held.some(lock => lock.name === `framelab-extract-${id}`) : Date.now() - (p.heartbeat || 0) < 600000;
      if (!active) {
        p.status = 'error'; p.error = 'The page closed during extraction. Choose your video again to create a new project.';
        await put(p);
      }
    }
    return p;
  }
  function validate(label, reviewed, duration) {
    if (!label || typeof label !== 'object' || Array.isArray(label)) throw Error('Invalid event annotation.');
    if (reviewed && (typeof label.class !== 'string' || !label.class.trim())) throw Error('Choose a Class, or select Other and enter your own.');
    const result = {class:String(label.class || '').trim().slice(0,2000), event_id:String(label.event_id || '').trim().slice(0,2000)};
    for (const [letter, standard] of Object.entries(groups)) {
      const source = label[letter] || {};
      if (typeof source !== 'object' || Array.isArray(source)) throw Error(`${letter} must be an object.`);
      result[letter] = {};
      for (const key of standard) result[letter][key] = String(source[key] ?? '').trim().slice(0,2000);
      const reserved = new Set([...standard, ...(letter === 'O' ? ['evidence_interval'] : [])]);
      const extras = Object.entries(source).filter(([key]) => !reserved.has(key));
      if (extras.length > 50) throw Error(`${letter} supports up to 50 custom fields.`);
      for (const [rawKey, value] of extras) {
        const key = rawKey.trim();
        if (!key || key.length > 80 || ['__proto__','constructor','prototype'].includes(key) || Object.hasOwn(result[letter],key) || reserved.has(key)) throw Error(`${letter}: use a unique custom field name (1–80 characters).`);
        if (typeof value !== 'string' || value.length > 2000) throw Error(`${letter}.${key}: use text up to 2,000 characters.`);
        result[letter][key] = value.trim();
        if (reviewed && !value.trim()) throw Error(`Fill in ${letter}.${key}, or remove it before marking complete.`);
      }
    }
    function seconds(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration + .001) throw Error(`Times must be numeric seconds between 0 and ${duration.toFixed(2)}.`);
      return value;
    }
    result.time = Object.fromEntries(['start','end','outcome_observed_at'].map(key => [key,seconds(label.time?.[key])]));
    const interval = label.O?.evidence_interval ?? [null,null];
    if (!Array.isArray(interval) || interval.length !== 2) throw Error('Evidence interval must contain a start and an end.');
    result.O.evidence_interval = interval.map(seconds);
    const t = result.time, [a,b] = result.O.evidence_interval;
    if (t.start !== null && t.end !== null && t.start > t.end) throw Error('Event start must be at or before event end.');
    if (t.end !== null && t.outcome_observed_at !== null && t.end > t.outcome_observed_at) throw Error('Outcome observation must be at or after event end.');
    if (a !== null && b !== null && a > b) throw Error('Evidence start must be at or before evidence end.');
    if (reviewed && (!result.event_id || Object.values(t).includes(null) || result.O.evidence_interval.includes(null) || Object.entries(groups).some(([g,keys]) => keys.some(key => !result[g][key])))) throw Error('Complete Event ID, all times, and all X/Y/T/Z/O fields before marking reviewed.');
    return result;
  }
  async function request(url, options = {}) {
    const path = new URL(url, location.href).pathname;
    if (path === '/api/projects') {
      const items = await run('projects','readonly',store => store.getAll());
      return Promise.all(items.sort((a,b) => b.created_at.localeCompare(a.created_at)).map(async item => {
        const p = await readProject(item.id);
        return Object.fromEntries(['id','name','status','created_at','annotator'].map(key => [key,p[key]]));
      }));
    }
    const match = path.match(/^\/api\/projects\/([a-f0-9]+)(?:\/frames\/(\d+))?$/);
    if (!match) throw Error('Unknown project operation.');
    const [,id,fid] = match;
    if (!fid) return readProject(id);
    const body = JSON.parse(options.body), annotator = String(body.annotator || '').trim().slice(0,200);
    if (!annotator) throw Error('Enter an annotator name or ID.');
    if (!Array.isArray(body.labels) || body.labels.length > 100) throw Error('Each frame supports up to 100 event annotations.');
    return update(id,p => {
      const frame = p.frames[Number(fid)-1];
      if (p.status !== 'ready' || !frame) throw Error('Frame not found or extraction is not ready.');
      const labels = body.labels.map(label => validate(label,!!body.reviewed,p.duration));
      if(p.kind==='clips')for(const label of labels){
        if(label.time.start!==null&&label.time.start<frame.start-.000001)throw Error('Event start must be within this clip.');
        if(label.time.end!==null&&label.time.end>frame.end+.000001)throw Error('Event end must be within this clip. Outcome evidence may occur later in the video.');
      }
      Object.assign(frame,{labels,reviewed:!!body.reviewed,annotator,updated_at:now()});
      p.annotator = annotator; p.completed=false; return frame;
    });
  }
  function waitEvent(target, event, action, timeout = 30000) {
    return new Promise((resolve,reject) => {
      let timer;
      const cleanup = () => { target.removeEventListener(event,success); target.removeEventListener('error',failed); clearTimeout(timer); };
      const success = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(Error('This browser cannot decode this video. Try an H.264 MP4 file.')); };
      target.addEventListener(event,success,{once:true}); target.addEventListener('error',failed,{once:true});
      timer = setTimeout(() => {cleanup();reject(Error('Video decoding timed out. Try a shorter H.264 MP4 video.'));},timeout);
      try { action?.(); } catch(error) {cleanup();reject(error);}
    });
  }
  async function sample(p,file) {
    const video = document.createElement('video'), source = URL.createObjectURL(file);
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    try {
      await waitEvent(video,'loadeddata',() => {video.src=source; video.load();});
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) throw Error('Could not read this video. Try an H.264 MP4 file.');
      p.duration = video.duration; p.width = video.videoWidth; p.height = video.videoHeight;
      const count = Math.ceil(p.duration / p.interval - 1e-9);
      if (count > 50000) throw Error('More than 50,000 frames expected. Choose a larger interval.');
      await put(p);
      const canvas = document.createElement('canvas'); canvas.width=p.width; canvas.height=p.height;
      const ctx = canvas.getContext('2d',{alpha:false});
      for (let i=0;i<count;i++) {
        const timestamp = Number((i*p.interval).toFixed(6));
        if (Math.abs(video.currentTime-timestamp) > .00001) await waitEvent(video,'seeked',() => {video.currentTime=timestamp;});
        if (video.readyState < 2) await waitEvent(video,'loadeddata');
        ctx.drawImage(video,0,0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.94));
        if (!blob) throw Error('Could not encode a frame. Try a lower-resolution video.');
        const file_name = `${String(i+1).padStart(6,'0')}.jpg`;
        await run('images','readwrite',store => store.put({key:`${p.id}/${file_name}`,project_id:p.id,blob}));
        p.frames.push({id:i+1,file_name,timestamp,labels:[],reviewed:false});
        p.extracted=i+1; p.heartbeat=Date.now();
        if (i%20===0) await put(p);
      }
      p.status='ready'; await put(p);
    } catch(error) {
      p.status='error';
      p.error = error.name === 'QuotaExceededError' ? 'Browser storage is full. Free site storage or use a shorter video / larger sampling interval.' : error.message;
      try { await put(p); } catch { /* The in-memory error is still shown when storage is full. */ }
    } finally {video.removeAttribute('src');video.load();URL.revokeObjectURL(source);if(p.status==='ready')jobs.delete(p.id);}
  }
  async function create(file,interval,annotator) {
    await ready;
    if (!annotator.trim()) throw Error('Enter an annotator name or ID.');
    if (!Number.isFinite(interval) || interval < .04 || interval > 3600) throw Error('Choose an interval between 0.04 and 3600 seconds.');
    if (file.size > 20*1024**3) throw Error('Videos must be smaller than 20 GB.');
    const p={id:crypto.randomUUID().replaceAll('-',''),name:file.name,interval,annotator:annotator.trim(),created_at:now(),status:'processing',extracted:0,frames:[],heartbeat:Date.now()};
    await put(p); jobs.set(p.id,p);
    navigator.storage?.persist?.().catch(() => {});
    const start = () => sample(p,file);
    if (navigator.locks) navigator.locks.request(`framelab-extract-${p.id}`,start).catch(error => {p.status='error';p.error=error.message;put(p).catch(()=>{});});
    else start();
    return copy(p);
  }
  async function attachImage(img,id,name) {
    const ticket = `${id}/${name}`; img.dataset.imageKey=ticket;
    try {
      const item = await run('images','readonly',store => store.get(ticket));
      if (!item || img.dataset.imageKey!==ticket || !img.isConnected) return;
      const url=URL.createObjectURL(item.blob); imageURLs.add(url); img.src=url;
    } catch { img.alt='Image unavailable in browser storage'; }
  }
  function releaseImages() {for(const url of imageURLs)URL.revokeObjectURL(url);imageURLs.clear();}
  async function createClipProject(file,annotator) {
    await ready;
    if(!annotator.trim())throw Error('Enter an annotator name or ID.');
    if(!file||file.size>20*1024**3)throw Error('Choose a video smaller than 20 GB.');
    const video=document.createElement('video'),url=URL.createObjectURL(file);
    video.preload='metadata';video.muted=true;video.playsInline=true;
    try{
      await waitEvent(video,'loadedmetadata',()=>{video.src=url;video.load();});
      if(!Number.isFinite(video.duration)||video.duration<=0||!video.videoWidth)throw Error('Could not read this video. Try an H.264 MP4 file.');
      const p={id:crypto.randomUUID().replaceAll('-',''),name:file.name,kind:'clips',annotator:annotator.trim().slice(0,200),
        created_at:now(),status:'ready',completed:false,duration:video.duration,width:video.videoWidth,height:video.videoHeight,
        segmentCuts:[0,video.duration],frames:[],nextClipId:1};
      await new Promise((resolve,reject)=>{
        const tx=database.transaction(['projects','videos'],'readwrite');
        tx.objectStore('projects').put(p);tx.objectStore('videos').put({id:p.id,blob:file});
        tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(Error('Could not save this video in browser storage. Free site storage or choose a smaller video.'));
      });
      navigator.storage?.persist?.().catch(()=>{});return p;
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  }
  async function attachVideo(video,id) {
    if(video.dataset.projectId===id&&videoURLs.has(id)&&video.src===videoURLs.get(id))return;
    const record=await run('videos','readonly',store=>store.get(id));
    if(!record)throw Error('The source video is missing from this browser. Upload it as a new project.');
    for(const [key,url]of videoURLs)if(key!==id){URL.revokeObjectURL(url);videoURLs.delete(key);}
    if(!videoURLs.has(id))videoURLs.set(id,URL.createObjectURL(record.blob));
    await waitEvent(video,'loadedmetadata',()=>{video.src=videoURLs.get(id);video.load();});
    video.dataset.projectId=id;
  }
  async function saveCuts(id,cuts) {
    return update(id,p=>{
      if(p.kind!=='clips')throw Error('This is a legacy frame project.');
      p.segmentCuts=clipModel.normalize(cuts,p.duration);p.segmentation_updated_at=now();return p;
    });
  }
  async function confirmCuts(id,cuts,{allowReset=false}={}) {
    return update(id,p=>{
      if(p.kind!=='clips')throw Error('This is a legacy frame project.');
      const plan=clipModel.plan(p,cuts);
      if(plan.affectedCount&&!allowReset)throw Error('Changing these boundaries affects existing annotations. Confirm resetting affected clips first.');
      p.frames=plan.clips;p.segmentCuts=plan.cuts;p.nextClipId=plan.nextClipId;p.status='ready';p.segmentation_updated_at=now();return p;
    });
  }
  async function addClip(id,start,end) {
    return update(id,p=>{
      if(p.kind!=='clips'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>p.duration||end-start<.25)throw Error('Choose a clip of at least 0.25 seconds within the video.');
      const number=p.nextClipId||p.frames.length+1;
      p.frames.push({id:p.frames.length+1,clip_id:`clip_${String(number).padStart(3,'0')}`,start,end,labels:[],reviewed:false});
      p.nextClipId=number+1;p.status='ready';p.completed=false;return p;
    });
  }
  async function finishProject(id) {
    return update(id,p=>{
      if(!p.frames.length||p.frames.some(c=>!c.reviewed))throw Error('Save and complete every clip before finishing the project.');
      p.completed=true;p.completed_at=now();return p;
    });
  }
  async function backup(id) {
    const p=await readProject(id);
    if(p.kind!=='clips')throw Error('Progress backup is available for clip projects.');
    downloadBlob(new Blob([JSON.stringify({format:'talktosim-progress',version:1,project:p},null,2)],{type:'application/json'}),`progress-${p.id.slice(0,8)}.json`);
  }
  async function importProgress(file,video,annotator) {
    const data=JSON.parse(await file.text());
    let source=data.format==='talktosim-progress'?data.project:null;
    if(!source&&data.info?.annotation_type==='video_clip_semantics'&&data.videos?.length===1){
      const v=data.videos[0];source={kind:'clips',name:v.source_name||data.info.source_video,duration:v.duration_seconds,width:v.width,height:v.height,annotator,frames:data.clips.map((c,i)=>({id:i+1,clip_id:c.id,start:c.start,end:c.end,reviewed:c.reviewed,annotator:c.annotator,labels:data.events.filter(e=>e.clip_id===c.id)}))};
    }
    if(!source||source.kind!=='clips'||!Array.isArray(source.frames)||source.frames.length>20000)throw Error('Choose a FrameLab progress JSON or complete clip dataset annotations.json.');
    if(!video||video.name!==source.name)throw Error('Select the original video with the same filename as the progress file.');
    if(!Number.isFinite(source.duration)||source.duration<=0)throw Error('Invalid source duration.');
    const ids=new Set();
    const frames=source.frames.map((c,i)=>{
      if(!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end>source.duration||c.end<=c.start||typeof c.clip_id!=='string'||ids.has(c.clip_id)||!Array.isArray(c.labels)||c.labels.length>100)throw Error('Invalid clip in the progress file.');
      ids.add(c.clip_id);const labels=c.labels.map(l=>validate(l,!!c.reviewed,source.duration));
      for(const l of labels)if((l.time.start!==null&&l.time.start<c.start)||(l.time.end!==null&&l.time.end>c.end))throw Error('Event times are outside their clip.');
      return {id:i+1,clip_id:c.clip_id,start:c.start,end:c.end,reviewed:!!c.reviewed,labels,annotator:String(c.annotator||annotator||'').slice(0,200),updated_at:c.updated_at||null};
    });
    const created=await createClipProject(video,annotator||source.annotator||'Doctor');
    try{
      if(Math.abs(created.duration-source.duration)>.1||created.width!==source.width||created.height!==source.height)throw Error('This video does not match the saved progress duration or dimensions.');
      return await update(created.id,p=>{p.frames=frames;p.nextClipId=Math.max(frames.length,...frames.map(c=>Number(c.clip_id.match(/^clip_(\d+)$/)?.[1])||0))+1;p.completed=false;return p;});
    }catch(e){await remove(created.id);throw e;}
  }
  function clipDataset(p,onlyReviewed) {
    const clips=p.frames.filter(c=>!onlyReviewed||c.reviewed);
    if(!clips.length)throw Error('No clips to export. Complete a clip or export all clips.');
    const categories=[...new Set(clips.flatMap(c=>c.labels.map(l=>l.class)))].sort().map((name,i)=>({id:i+1,name}));
    const ids=new Map(categories.map(c=>[c.name,c.id]));
    const data={info:{description:p.name,version:'3.0',date_created:p.created_at,annotation_type:'video_clip_semantics',time_unit:'seconds',source_video:p.name},
      videos:[{id:p.id,file_name:`source/${p.name.replaceAll('/','_').replaceAll('\\','_')}`,source_name:p.name,duration_seconds:p.duration,width:p.width,height:p.height}],clips:[],categories,annotations:[],events:[]};
    for(const c of clips){
      data.clips.push({id:c.clip_id,video_id:p.id,start:c.start,end:c.end,duration_seconds:Number((c.end-c.start).toFixed(6)),reviewed:c.reviewed,annotator:c.annotator||'',updated_at:c.updated_at||null});
      for(const label of c.labels){
        const event={...copy(label),clip_id:c.clip_id,video_id:p.id,clip_start:c.start,clip_end:c.end,annotator:c.annotator||'',updated_at:c.updated_at||null,reviewed:c.reviewed};
        data.events.push(event);data.annotations.push({id:data.annotations.length+1,category_id:ids.get(label.class),...event});
      }
    }
    return data;
  }
  function dataset(p,onlyReviewed) {
    if(p.kind==='clips')return clipDataset(p,onlyReviewed);
    const frames=p.frames.filter(f => !onlyReviewed || f.reviewed);
    if (!frames.length) throw Error('No frames to export. Complete a frame or export all frames.');
    const categories=[...new Set(frames.flatMap(f=>f.labels.map(l=>l.class)))].sort().map((name,i)=>({id:i+1,name,supercategory:'semantic'}));
    const ids=new Map(categories.map(c=>[c.name,c.id]));
    const data={info:{description:p.name,version:'2.0',date_created:p.created_at,source_video:p.name,sample_interval_seconds:p.interval,annotation_type:'frame_semantics',schema:'COCO + XYTZO semantic attributes'},licenses:[],categories,images:[],annotations:[],events:[]};
    for(const f of frames) {
      data.images.push({id:f.id,file_name:`images/${f.file_name}`,width:p.width,height:p.height,timestamp_seconds:f.timestamp,reviewed:f.reviewed,annotator:f.annotator||'',updated_at:f.updated_at||null});
      for(const label of f.labels) {
        data.annotations.push({id:data.annotations.length+1,image_id:f.id,category_id:ids.get(label.class),attributes:{instrument:label.X.instrument,action:label.Y.action,target:label.T.anatomy,intention:label.Z.intended_goal,outcome:label.O.observed_effect},...copy(label),annotator:f.annotator||'',updated_at:f.updated_at||null});
        data.events.push({...copy(label),image_id:f.id,annotator:f.annotator||'',updated_at:f.updated_at||null,reviewed:f.reviewed});
      }
    }
    return data;
  }
  const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  async function crc32(blob) {
    let crc=0xffffffff; const reader=blob.stream().getReader();
    while(true){const {done,value}=await reader.read();if(done)break;for(const byte of value)crc=(crc>>>8)^crcTable[(crc^byte)&255];}
    return (crc^0xffffffff)>>>0;
  }
  function header(size){const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)};}
  async function zip(entries,progress) {
    const encoder=new TextEncoder(),parts=[],central=[];let offset=0,count=0;
    for await(const [name,blob] of entries) {
      const filename=encoder.encode(name),crc=await crc32(blob),largeOffset=offset>=0xffffffff,largeSize=blob.size>=0xffffffff;
      const local=header(30),localExtra=header(largeSize?20:0);
      local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,largeSize?45:20,true);local.view.setUint16(6,0x800,true);
      local.view.setUint16(12,33,true);local.view.setUint32(14,crc,true);local.view.setUint32(18,largeSize?0xffffffff:blob.size,true);local.view.setUint32(22,largeSize?0xffffffff:blob.size,true);local.view.setUint16(26,filename.length,true);local.view.setUint16(28,localExtra.bytes.length,true);
      if(largeSize){localExtra.view.setUint16(0,1,true);localExtra.view.setUint16(2,16,true);localExtra.view.setBigUint64(4,BigInt(blob.size),true);localExtra.view.setBigUint64(12,BigInt(blob.size),true);}
      parts.push(local.bytes,filename,localExtra.bytes,blob);
      const extraSize=(largeSize?16:0)+(largeOffset?8:0),extra=header(extraSize?extraSize+4:0);
      if(extraSize){extra.view.setUint16(0,1,true);extra.view.setUint16(2,extraSize,true);let at=4;
        if(largeSize){extra.view.setBigUint64(at,BigInt(blob.size),true);extra.view.setBigUint64(at+8,BigInt(blob.size),true);at+=16;}
        if(largeOffset)extra.view.setBigUint64(at,BigInt(offset),true);
      }
      const directory=header(46);directory.view.setUint32(0,0x02014b50,true);directory.view.setUint16(4,45,true);directory.view.setUint16(6,extraSize?45:20,true);directory.view.setUint16(8,0x800,true);
      directory.view.setUint16(14,33,true);directory.view.setUint32(16,crc,true);directory.view.setUint32(20,largeSize?0xffffffff:blob.size,true);directory.view.setUint32(24,largeSize?0xffffffff:blob.size,true);directory.view.setUint16(28,filename.length,true);
      directory.view.setUint16(30,extra.bytes.length,true);directory.view.setUint32(42,largeOffset?0xffffffff:offset,true);central.push(directory.bytes,filename,extra.bytes);
      offset+=local.bytes.length+filename.length+localExtra.bytes.length+blob.size;count++;progress?.(count);
    }
    const size=central.reduce((sum,b)=>sum+b.length,0),need64=offset>0xffffffff||size>0xffffffff||count>65535;
    for(const part of central)parts.push(part);
    if(need64){
      const record=header(56);record.view.setUint32(0,0x06064b50,true);record.view.setBigUint64(4,44n,true);record.view.setUint16(12,45,true);record.view.setUint16(14,45,true);
      record.view.setBigUint64(24,BigInt(count),true);record.view.setBigUint64(32,BigInt(count),true);record.view.setBigUint64(40,BigInt(size),true);record.view.setBigUint64(48,BigInt(offset),true);parts.push(record.bytes);
      const locator=header(20);locator.view.setUint32(0,0x07064b50,true);locator.view.setBigUint64(8,BigInt(offset+size),true);locator.view.setUint32(16,1,true);parts.push(locator.bytes);
    }
    const end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,Math.min(count,65535),true);end.view.setUint16(10,Math.min(count,65535),true);
    end.view.setUint32(12,Math.min(size,0xffffffff),true);end.view.setUint32(16,Math.min(offset,0xffffffff),true);parts.push(end.bytes);
    return new Blob(parts,{type:'application/zip'});
  }
  function downloadBlob(blob,name) {
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function exportData(id,format,onlyReviewed,progress,options={}) {
    const p=await readProject(id);if(p.status!=='ready')throw Error('Wait until extraction finishes.');
    const data=dataset(p,onlyReviewed),json=value=>new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
    if(format==='json'){downloadBlob(json(data),'annotations.json');return;}
    if(format==='events'){downloadBlob(json(data.events),'events.json');return;}
    if(format==='clips'){downloadBlob(json(data.clips||[]),'clips.json');return;}
    if(p.kind==='clips'){
      async function* clipEntries(){
        yield ['annotations.json',json(data)];yield ['events.json',json(data.events)];yield ['clips.json',json(data.clips)];
        yield ['README.txt',new Blob(['Video clip annotation dataset\nClips are time ranges in the source video, in seconds. Independent trimmed video files are not generated.\nannotations.json: complete videos/clips/categories/annotations/events dataset. clips.json: clip intervals.\nSource video is included under source/ only when selected for local download. Never included in GitHub uploads.\n'])];
        if(options.includeVideo){const source=await run('videos','readonly',store=>store.get(id));if(!source)throw Error('Source video unavailable.');yield [`source/${p.name.replaceAll('/','_').replaceAll('\\','_')}`,source.blob];}
      }
      downloadBlob(await zip(clipEntries(),progress),`clip-dataset-${id.slice(0,8)}.zip`);return;
    }
    async function* entries(){
      yield ['annotations.json',json(data)];yield ['events.json',json(data.events)];
      yield ['README.txt',new Blob(['FrameLab browser-local dataset\nFrame-level COCO-compatible tables with nested event semantics and custom fields.\nimages/: full-resolution JPG files. annotations.json: complete dataset. events.json: event records.\nAll event times use seconds from source-video start. Image timestamps are sampling-grid positions.\nreviewed=false: draft; reviewed=true and no annotations: explicit negative example.\nSource video is not included. Videos and annotations are processed and stored on the user device.\n'])];
      for(const image of data.images){const record=await run('images','readonly',store=>store.get(`${id}/${image.file_name.split('/').pop()}`));if(!record)throw Error(`Missing image: ${image.file_name}.`);yield [image.file_name,record.blob];}
    }
    const blob=await zip(entries(),progress);downloadBlob(blob,`dataset-${id.slice(0,8)}.zip`);
  }
  async function prepareSubmission(id,{onlyReviewed=true,includeImages=false}={},progress) {
    const p=await readProject(id);if(p.status!=='ready')throw Error('Wait until extraction finishes.');
    if(p.kind==='clips'&&!p.completed)throw Error('Finish the project before uploading to GitHub. Download progress to continue locally.');
    const data=dataset(p,onlyReviewed),json=value=>new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
    const files=[{name:'annotations.json',blob:json(data)},{name:'events.json',blob:json(data.events)}];
    if(p.kind==='clips'){
      if(includeImages)throw Error('Clip uploads contain JSON only; the source video is never uploaded.');
      files.push({name:'clips.json',blob:json(data.clips)});
      return {annotator:p.annotator,projectId:p.id,sourceVideo:p.name,unitType:'clips',clipCount:data.clips.length,
        frameCount:0,annotationCount:data.annotations.length,onlyReviewed,includeImages:false,files};
    }
    if(includeImages) {
      async function* entries(){
        yield ['annotations.json',files[0].blob];yield ['events.json',files[1].blob];
        for(const image of data.images){
          const record=await run('images','readonly',store=>store.get(`${id}/${image.file_name.split('/').pop()}`));
          if(!record)throw Error(`Missing image: ${image.file_name}.`);
          yield [image.file_name,record.blob];
        }
      }
      files.push({name:'dataset.zip',blob:await zip(entries(),progress)});
    }
    return {annotator:p.annotator,projectId:p.id,sourceVideo:p.name,frameCount:data.images.length,
      annotationCount:data.annotations.length,onlyReviewed,includeImages,files};
  }
  async function remove(id) {
    if(jobs.get(id)?.status==='processing')throw Error('Wait for extraction to finish before deleting this project.');
    await ready;
    await new Promise((resolve,reject)=>{
      const tx=database.transaction(['projects','images','videos'],'readwrite');tx.objectStore('projects').delete(id);tx.objectStore('videos').delete(id);
      const cursor=tx.objectStore('images').index('project_id').openCursor(IDBKeyRange.only(id));
      cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
      tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);
    });jobs.delete(id);if(videoURLs.has(id)){URL.revokeObjectURL(videoURLs.get(id));videoURLs.delete(id);}
  }
  window.frameStore={request,create,createClipProject,addClip,finishProject,backup,importProgress,saveCuts,confirmCuts,attachVideo,attachImage,releaseImages,exportData,prepareSubmission,remove};
})();
