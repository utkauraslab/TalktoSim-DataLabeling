/* Browser-local storage, video sampling and portable dataset exports. No upload server. */
(() => {
  const now = () => new Date().toISOString();
  const copy = value => structuredClone(value);
  const jobs = new Map(), imageURLs = new Set();
  const groups = {X:['instrument'], Y:['action','direction'], T:['anatomy','region'],
    Z:['intended_goal','goal_type','source'], O:['observed_effect','goal_achieved','source']};
  let database;
  const ready = new Promise((resolve, reject) => {
    const request = indexedDB.open('talktosim-framelab-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('projects', {keyPath:'id'});
      const images = db.createObjectStore('images', {keyPath:'key'});
      images.createIndex('project_id', 'project_id');
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
    if (typeof label.class !== 'string' || !label.class.trim()) throw Error('Choose a Class, or select Other and enter your own.');
    const result = {class:label.class.trim().slice(0,2000), event_id:String(label.event_id || '').trim().slice(0,2000)};
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
      Object.assign(frame,{labels,reviewed:!!body.reviewed,annotator,updated_at:now()});
      p.annotator = annotator; return frame;
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
  function dataset(p,onlyReviewed) {
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
      if(blob.size>0xffffffff)throw Error('An individual dataset file exceeds the ZIP limit. Export a smaller set.');
      const filename=encoder.encode(name),crc=await crc32(blob),largeOffset=offset>0xffffffff;
      const local=header(30);local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,20,true);local.view.setUint16(6,0x800,true);
      local.view.setUint16(12,33,true);local.view.setUint32(14,crc,true);local.view.setUint32(18,blob.size,true);local.view.setUint32(22,blob.size,true);local.view.setUint16(26,filename.length,true);
      parts.push(local.bytes,filename,blob);
      const directory=header(46);directory.view.setUint32(0,0x02014b50,true);directory.view.setUint16(4,45,true);directory.view.setUint16(6,largeOffset?45:20,true);directory.view.setUint16(8,0x800,true);
      directory.view.setUint16(14,33,true);directory.view.setUint32(16,crc,true);directory.view.setUint32(20,blob.size,true);directory.view.setUint32(24,blob.size,true);directory.view.setUint16(28,filename.length,true);
      directory.view.setUint16(30,largeOffset?12:0,true);directory.view.setUint32(42,largeOffset?0xffffffff:offset,true);central.push(directory.bytes,filename);
      if(largeOffset){const extra=header(12);extra.view.setUint16(0,1,true);extra.view.setUint16(2,8,true);extra.view.setBigUint64(4,BigInt(offset),true);central.push(extra.bytes);}
      offset+=local.bytes.length+filename.length+blob.size;count++;progress?.(count);
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
  async function exportData(id,format,onlyReviewed,progress) {
    const p=await readProject(id);if(p.status!=='ready')throw Error('Wait until extraction finishes.');
    const data=dataset(p,onlyReviewed),json=value=>new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
    if(format==='json'){downloadBlob(json(data),'annotations.json');return;}
    if(format==='events'){downloadBlob(json(data.events),'events.json');return;}
    async function* entries(){
      yield ['annotations.json',json(data)];yield ['events.json',json(data.events)];
      yield ['README.txt',new Blob(['FrameLab browser-local dataset\nFrame-level COCO-compatible tables with nested event semantics and custom fields.\nimages/: full-resolution JPG files. annotations.json: complete dataset. events.json: event records.\nAll event times use seconds from source-video start. Image timestamps are sampling-grid positions.\nreviewed=false: draft; reviewed=true and no annotations: explicit negative example.\nSource video is not included. Videos and annotations are processed and stored on the user device.\n'])];
      for(const image of data.images){const record=await run('images','readonly',store=>store.get(`${id}/${image.file_name.split('/').pop()}`));if(!record)throw Error(`Missing image: ${image.file_name}.`);yield [image.file_name,record.blob];}
    }
    const blob=await zip(entries(),progress);downloadBlob(blob,`dataset-${id.slice(0,8)}.zip`);
  }
  async function remove(id) {
    if(jobs.get(id)?.status==='processing')throw Error('Wait for extraction to finish before deleting this project.');
    await ready;
    await new Promise((resolve,reject)=>{
      const tx=database.transaction(['projects','images'],'readwrite');tx.objectStore('projects').delete(id);
      const cursor=tx.objectStore('images').index('project_id').openCursor(IDBKeyRange.only(id));
      cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
      tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);
    });jobs.delete(id);
  }
  window.frameStore={request,create,attachImage,releaseImages,exportData,remove};
})();
