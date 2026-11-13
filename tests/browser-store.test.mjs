import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';

const source=readFileSync(new URL('../static/browser-store.js',import.meta.url),'utf8');
const clipSource=readFileSync(new URL('../static/clip-model.js',import.meta.url),'utf8');
const example=JSON.parse(readFileSync(new URL('../static/example.json',import.meta.url),'utf8'));
// Frame fixtures keep their original source-video timing contract.
delete example.time_reference;delete example.clip_start;delete example.clip_end;
const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
function harness({db=new IDBFactory(),duration=2,broken=false}={}) {
  const downloads=[],urls=new Map(),locks=new Set(),sampled=[];
  let next=0;
  class Video extends EventTarget {
    current=0;videoWidth=320;videoHeight=240;readyState=2;duration=duration;dataset={};
    set currentTime(value){this.current=value;queueMicrotask(()=>this.dispatchEvent(new Event('seeked')));}
    get currentTime(){return this.current;}
    load(){if(this.src)queueMicrotask(()=>{if(broken)this.dispatchEvent(new Event('error'));else{this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('loadeddata'));}});}
    removeAttribute(name){delete this[name];}
  }
  const objectURL={createObjectURL(blob){const url=`blob:test/${++next}`;urls.set(url,blob);return url;},revokeObjectURL(url){urls.delete(url);}};
  const context=vm.createContext({window:{},indexedDB:db,IDBKeyRange,structuredClone,URL:class extends URL {
    static createObjectURL=objectURL.createObjectURL;static revokeObjectURL=objectURL.revokeObjectURL;
  },Blob,TextEncoder,crypto:webcrypto,console,location:{href:'https://utkauraslab.github.io/TalktoSim-DataLabeling/'},
    navigator:{storage:{persist:async()=>true},locks:{
      async request(name,fn){locks.add(name);try{return await fn();}finally{locks.delete(name);}},
      async query(){return {held:[...locks].map(name=>({name}))};}
    }},
    document:{body:{append(){}},createElement(type){
      if(type==='video')return new Video();
      if(type==='canvas')return {getContext(){return {drawImage(video){sampled.push(video.currentTime);}};},toBlob(done){done(new Blob(['fake-jpeg-bytes'],{type:'image/jpeg'}));}};
      if(type==='a')return {click(){downloads.push({name:this.download,blob:urls.get(this.href)});},remove(){}};
      throw Error(type);
    }},
    setTimeout(fn,ms){const timer=setTimeout(fn,ms);if(ms>=60000)timer.unref();return timer;},clearTimeout
  });
  vm.runInContext(clipSource,context);context.clipModel=context.window.clipModel;
  vm.runInContext(source,context);
  return {store:context.window.frameStore,model:context.window.clipModel,downloads,sampled,db,createVideo:()=>new Video()};
}
async function create(h,interval=0.5) {
  const p=await h.store.create(new File(['video'],'sample.mp4'),interval,'Alice');
  for(let i=0;i<500;i++) {
    const current=await h.store.request(`/api/projects/${p.id}`);
    if(current.status!=='processing')return current;
    await pause();
  }
  throw Error('Extraction did not finish');
}
function record(){return {...structuredClone(example),class:'tension',time:{start:0,end:1,outcome_observed_at:2},O:{...example.O,evidence_interval:[1,2]},Z:{...example.Z,xxx:'Custom intention'}};}
const save=(h,p,labels,reviewed=true)=>h.store.request(`/api/projects/${p.id}/frames/1`,{body:JSON.stringify({labels,reviewed,annotator:'Expert A'})});
const plain=value=>JSON.parse(JSON.stringify(value));

test('sampling intervals, timestamps, persistent project metadata and image attachments',async()=>{
  for(const [interval,count] of [[0.5,4],[1,2],[5,1]]) {
    const h=harness(),p=await create(h,interval);
    assert.equal(p.status,'ready');assert.equal(p.frames.length,count);
    assert.deepEqual(plain(p.frames.map(f=>f.timestamp)),Array.from({length:count},(_,i)=>i*interval));
    assert.deepEqual(h.sampled,Array.from({length:count},(_,i)=>i*interval));
    assert.equal(p.width,320);assert.equal(p.height,240);
    const img={dataset:{},isConnected:true};await h.store.attachImage(img,p.id,'000001.jpg');assert.match(img.src,/^blob:/);
    const reopened=harness({db:h.db});assert.equal((await reopened.store.request(`/api/projects/${p.id}`)).frames.length,count);
  }
});

test('nested event, custom Class and fields survive save, reopen, JSON and ZIP exports',async()=>{
  const h=harness(),p=await create(h),label=record();label.class='my_custom_class';
  for(const group of ['X','Y','T','Z','O'])label[group].extra_note=`Note for ${group}`;
  assert.deepEqual(plain((await save(h,p,[label])).labels),[label]);
  const reopened=harness({db:h.db});
  assert.deepEqual(plain((await reopened.store.request(`/api/projects/${p.id}`)).frames[0].labels),[label]);
  await h.store.exportData(p.id,'events',true);
  const events=JSON.parse(await h.downloads.at(-1).blob.text());assert.equal(events.length,1);
  assert.equal(events[0].Z.xxx,'Custom intention');assert.equal(events[0].class,'my_custom_class');assert.equal(events[0].annotator,'Expert A');
  await h.store.exportData(p.id,'json',false);
  const data=JSON.parse(await h.downloads.at(-1).blob.text());assert.equal(data.images.length,4);assert.equal(data.categories[0].name,'my_custom_class');
  assert.deepEqual(data.annotations[0].O.evidence_interval,[1,2]);assert.equal(data.annotations[0].Z.extra_note,'Note for Z');
  await h.store.exportData(p.id,'zip',false);
  const dir=mkdtempSync(path.join(tmpdir(),'framelab-zip-')),archive=path.join(dir,'dataset.zip');
  try {
    writeFileSync(archive,Buffer.from(await h.downloads.at(-1).blob.arrayBuffer()));
    const verified=spawnSync('python3',['-c',[
      'import zipfile,json,sys',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'assert len(z.namelist()) == 7',
      'assert z.read("images/000001.jpg") == b"fake-jpeg-bytes"',
      'd=json.loads(z.read("annotations.json"))',
      'assert d["categories"][0]["name"] == "my_custom_class"',
      'assert d["events"] == json.loads(z.read("events.json"))',
      'assert d["events"][0]["Z"]["xxx"] == "Custom intention"'
    ].join('\n'),archive],{encoding:'utf8'});
    assert.equal(verified.status,0,verified.stderr);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('incomplete custom fields save as drafts, complete records require values',async()=>{
  const h=harness(),p=await create(h),label=record();label.Z.xxx='';
  await save(h,p,[label],false);await assert.rejects(save(h,p,[label],true),/Fill in Z.xxx/);
  await assert.rejects(h.store.exportData(p.id,'events',true),/No frames/);
  label.Z.xxx='Filled';await save(h,p,[label],true);await h.store.exportData(p.id,'events',true);
  assert.equal(JSON.parse(await h.downloads.at(-1).blob.text())[0].time.start,0);
});

test('invalid time, missing Class and reserved custom keys cannot overwrite saved data',async()=>{
  const h=harness(),p=await create(h);await save(h,p,[record()]);
  for(const mutate of [l=>l.time.start=-1,l=>l.time.end=3,l=>l.time.end='bad',l=>l.O.evidence_interval=[2,1],l=>l.class='',l=>l.Z.constructor='bad',l=>l.Z.xxx={object:true},l=>l.Z[' intended_goal ']='bad']) {
    const label=record();mutate(label);await assert.rejects(save(h,p,[label]));
    assert.equal((await h.store.request(`/api/projects/${p.id}`)).frames[0].labels[0].Z.xxx,'Custom intention');
  }
});

test('decode failure is actionable and does not export an incomplete dataset',async()=>{
  const h=harness({broken:true}),p=await create(h);assert.equal(p.status,'error');assert.match(p.error,/decode/);
  await assert.rejects(h.store.exportData(p.id,'json',false),/extraction/);
});

test('delete removes the project and its images while leaving another project intact',async()=>{
  const h=harness(),first=await create(h),second=await create(h);
  await h.store.remove(first.id);await assert.rejects(h.store.request(`/api/projects/${first.id}`),/not found/);
  const img={dataset:{},isConnected:true};await h.store.attachImage(img,first.id,'000001.jpg');assert.equal(img.src,undefined);
  assert.equal((await h.store.request('/api/projects')).length,1);
  assert.equal((await h.store.request(`/api/projects/${second.id}`)).status,'ready');
});

test('submission preparation respects reviewed/image options and never downloads or uploads automatically',async()=>{
  const h=harness(),p=await create(h);await save(h,p,[record()]);
  const labels=await h.store.prepareSubmission(p.id);
  assert.equal(labels.frameCount,1);assert.equal(labels.includeImages,false);
  assert.deepEqual(plain(labels.files.map(file=>file.name)),['annotations.json','events.json']);
  assert.equal(JSON.parse(await labels.files[0].blob.text()).events[0].Z.xxx,'Custom intention');
  assert.equal(h.downloads.length,0);
  const withImages=await h.store.prepareSubmission(p.id,{onlyReviewed:false,includeImages:true});
  assert.equal(withImages.frameCount,4);assert.equal(withImages.files[2].name,'dataset.zip');
  assert(withImages.files[2].blob.size>0);assert.equal(h.downloads.length,0);
});

test('video-first projects persist source and cuts; confirmed clips export true clip annotations',async()=>{
  const h=harness(),p=await h.store.createClipProject(new File(['source-video-bytes'],'case.mp4'),'Doctor A');
  assert.equal(p.kind,'clips');assert.equal(p.status,'ready');assert.equal(p.frames.length,0);
  await h.store.saveCuts(p.id,[0,.5,1.5,2]);
  const reloaded=harness({db:h.db}),draft=await reloaded.store.request(`/api/projects/${p.id}`);
  assert.deepEqual(plain(draft.segmentCuts),[0,.5,1.5,2]);
  const ready=await reloaded.store.confirmCuts(p.id,draft.segmentCuts);
  assert.deepEqual(plain(ready.frames.map(c=>[c.clip_id,c.start,c.end])),[['clip_001',0,.5],['clip_002',.5,1.5],['clip_003',1.5,2]]);
  const label=record();label.time.end=.5;await save(reloaded,ready,[label]);
  await reloaded.store.exportData(p.id,'json',true);
  const data=JSON.parse(await reloaded.downloads.at(-1).blob.text());
  assert.equal(data.info.version,'3.1');assert.equal(data.info.annotation_type,'video_clip_semantics');assert.equal(data.images,undefined);
  assert.equal(data.clips.length,1);assert.equal(data.clips[0].end,.5);assert.equal(data.events[0].clip_id,'clip_001');
  assert.equal(data.events[0].time.outcome_observed_at,2);assert.equal(data.events[0].Z.xxx,'Custom intention');
  await assert.rejects(reloaded.store.prepareSubmission(p.id),/Finish the project/);
  await reloaded.store.request(`/api/projects/${p.id}/frames/2`,{body:JSON.stringify({labels:[],reviewed:true,annotator:'Doctor'})});
  await reloaded.store.request(`/api/projects/${p.id}/frames/3`,{body:JSON.stringify({labels:[],reviewed:true,annotator:'Doctor'})});
  await reloaded.store.finishProject(p.id);
  const submission=await reloaded.store.prepareSubmission(p.id);
  assert.equal(submission.unitType,'clips');assert.equal(submission.clipCount,3);
  assert.deepEqual(plain(submission.files.map(f=>f.name)),['annotations.json','events.json','clips.json']);
  await assert.rejects(reloaded.store.prepareSubmission(p.id,{includeImages:true}),/never uploaded/);
  await reloaded.store.exportData(p.id,'zip',false,undefined,{includeVideo:true});
  const dir=mkdtempSync(path.join(tmpdir(),'framelab-clips-')),archive=path.join(dir,'clips.zip');
  try{
    writeFileSync(archive,Buffer.from(await reloaded.downloads.at(-1).blob.arrayBuffer()));
    const result=spawnSync('python3',['-c',[
      'import zipfile,json,sys','z=zipfile.ZipFile(sys.argv[1])','assert z.testzip() is None',
      'assert z.read("source/case.mp4") == b"source-video-bytes"',
      'clips=json.loads(z.read("clips.json"))','assert len(clips)==3',
      'assert json.loads(z.read("annotations.json"))["videos"][0]["file_name"] in z.namelist()',
      'assert [(c["start"],c["end"]) for c in clips] == [(0,.5),(.5,1.5),(1.5,2)]',
      'assert not any(n.startswith("images/") for n in z.namelist())'
    ].join('\n'),archive],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('changing cuts protects affected annotations and retains unchanged clip identities and review states',async()=>{
  const h=harness(),p=await h.store.createClipProject(new File(['v'],'case.mp4'),'Doctor');
  const ready=await h.store.confirmCuts(p.id,[0,.5,1.5,2]);
  const label=record();label.time.end=.5;await save(h,ready,[label]);
  await h.store.request(`/api/projects/${p.id}/frames/2`,{body:JSON.stringify({labels:[],reviewed:true,annotator:'Doctor'})});
  await assert.rejects(h.store.confirmCuts(p.id,[0,.25,.5,1.5,2]),/Confirm resetting/);
  assert.equal((await h.store.request(`/api/projects/${p.id}`)).frames[0].labels.length,1);
  const revised=await h.store.confirmCuts(p.id,[0,.25,.5,1.5,2],{allowReset:true});
  assert.equal(revised.frames[2].clip_id,'clip_002');assert.equal(revised.frames[2].reviewed,true);
  assert.equal(revised.frames[0].labels.length,0);assert.equal(revised.frames[1].labels.length,0);
  assert.notEqual(revised.frames[0].clip_id,'clip_001');
});

test('clip event action times stay inside its clip while outcome evidence may occur later',async()=>{
  const h=harness(),p=await h.store.createClipProject(new File(['v'],'case.mp4'),'Doctor');
  const ready=await h.store.confirmCuts(p.id,[0,1,2]);
  await save(h,ready,[record()]);
  const outside=record();outside.time.end=1.5;await assert.rejects(save(h,ready,[outside]),/within this clip/);
  const first=await h.store.request(`/api/projects/${p.id}`);assert.equal(first.frames[0].labels[0].time.end,1);
  const second=record();second.time.start=0;second.time.end=2;second.time.outcome_observed_at=2;
  await assert.rejects(h.store.request(`/api/projects/${p.id}/frames/2`,{body:JSON.stringify({labels:[second],reviewed:true,annotator:'Doctor'})}),/within this clip|Times must be numeric/);
});

test('partitions reject gaps, duplicates, short clips and non-numeric cuts; short videos can remain one clip',()=>{
  const h=harness();assert.deepEqual(plain(h.model.normalize([0,.1],.1)),[0,.1]);
  for(const cuts of [[.1,2],[0,1.9],[0,.1,2],[0,1,1,2],[0,NaN,2],[0,'1',2],[0,2,1,2]])assert.throws(()=>h.model.normalize(cuts,2));
});

test('upgrading a version-1 frame database preserves projects and saved images',async()=>{
  const db=new IDBFactory(),id='1'.repeat(32);
  await new Promise((resolve,reject)=>{
    const request=db.open('talktosim-framelab-v1',1);
    request.onupgradeneeded=()=>{const conn=request.result;conn.createObjectStore('projects',{keyPath:'id'});conn.createObjectStore('images',{keyPath:'key'}).createIndex('project_id','project_id');};
    request.onsuccess=()=>{
      const conn=request.result,tx=conn.transaction(['projects','images'],'readwrite');
      tx.objectStore('projects').put({id,name:'legacy.mp4',created_at:new Date().toISOString(),status:'ready',duration:2,width:320,height:240,interval:1,frames:[{id:1,file_name:'000001.jpg',timestamp:0,labels:[],reviewed:false}]});
      tx.objectStore('images').put({key:`${id}/000001.jpg`,project_id:id,blob:new Blob(['saved-image'])});
      tx.oncomplete=()=>{conn.close();resolve();};tx.onerror=()=>reject(tx.error);
    };request.onerror=()=>reject(request.error);
  });
  const h=harness({db}),p=await h.store.request(`/api/projects/${id}`);
  assert.equal(p.name,'legacy.mp4');assert.equal(p.frames.length,1);
  const image={dataset:{},isConnected:true};await h.store.attachImage(image,id,'000001.jpg');assert.match(image.src,/^blob:/);
  const clip=await h.store.createClipProject(new File(['source'],'new.mp4'),'Doctor');assert.equal(clip.kind,'clips');
  await h.store.remove(clip.id);await assert.rejects(h.store.attachVideo(h.createVideo(),clip.id),/source video is missing/i);
  assert.equal((await h.store.request(`/api/projects/${id}`)).name,'legacy.mp4');
});

test('incremental clips overlap, save drafts, resume from disk and require project completion for upload',async()=>{
  const h=harness({duration:14400}),video=new File(['long video'],'long.mp4');
  const p=await h.store.createClipProject(video,'Doctor');
  assert.equal(p.frames.length,0);
  await h.store.addClip(p.id,42,60);await h.store.addClip(p.id,50,80);
  let q=await h.store.request(`/api/projects/${p.id}`);
  assert.deepEqual(plain(q.frames.map(c=>[c.start,c.end])),[[42,60],[50,80]]);
  const draft=record();draft.class='';draft.time={start:0,end:18,outcome_observed_at:null};draft.O.evidence_interval=[null,null];
  await save(h,q,[draft],false);
  await h.store.backup(p.id);
  const backup=h.downloads.at(-1).blob;
  const restored=harness({duration:14400});
  const r=await restored.store.importProgress(backup,video,'Doctor');
  assert.notEqual(r.id,p.id);assert.equal(r.frames[0].labels[0].class,'');assert.equal(r.frames[0].reviewed,false);
  assert.deepEqual(plain(r.frames.map(c=>[c.start,c.end])),[[42,60],[50,80]]);
  await assert.rejects(restored.store.finishProject(r.id),/complete every clip/);
  await assert.rejects(restored.store.prepareSubmission(r.id),/Finish the project/);
  for(const c of r.frames)await restored.store.request(`/api/projects/${r.id}/frames/${c.id}`,{body:JSON.stringify({labels:[],reviewed:true,annotator:'Doctor'})});
  await restored.store.finishProject(r.id);
  assert.equal((await restored.store.prepareSubmission(r.id)).clipCount,2);
  await restored.store.addClip(r.id,55,65);
  await assert.rejects(restored.store.prepareSubmission(r.id),/Finish the project/);
  await assert.rejects(restored.store.importProgress(backup,new File(['x'],'wrong.mp4'),'Doctor'),/same filename/);
  await assert.rejects(restored.store.addClip(r.id,80,50),/Choose a clip/);
});

test('clip-relative defaults, save, export and backup round trips use one explicit time reference',async()=>{
  const h=harness({duration:100}),video=new File(['v'],'relative.mp4');
  const p=await h.store.createClipProject(video,'Doctor');await h.store.addClip(p.id,42,49.5);
  assert.deepEqual(plain(h.model.timingDefaults({start:42,end:49.5})),{start:0,end:7.5,outcome_observed_at:7.5});
  const label=record();label.time={start:0,end:7.5,outcome_observed_at:10};label.O.evidence_interval=[7.5,10];
  const saved=await save(h,p,[label]);assert.equal(saved.labels[0].time_reference,'clip');
  await h.store.exportData(p.id,'json',true);
  const exported=h.downloads.at(-1).blob,data=JSON.parse(await exported.text());
  assert.equal(data.info.event_time_reference,'clip');assert.equal(data.info.clip_boundary_time_reference,'source_video');
  assert.equal(data.events[0].clip_start,42);assert.equal(data.events[0].clip_end,49.5);
  assert.deepEqual(data.events[0].time,label.time);assert.deepEqual(data.events[0].O.evidence_interval,[7.5,10]);
  const newBrowser=harness({duration:100}),imported=await newBrowser.store.importProgress(exported,video,'Doctor');
  assert.deepEqual(plain(imported.frames[0].labels[0].time),label.time);
  await h.store.backup(p.id);const fromBackup=await newBrowser.store.importProgress(h.downloads.at(-1).blob,video,'Doctor');
  assert.deepEqual(plain(fromBackup.frames[0].labels[0].time),label.time);
  const invalid=structuredClone(label);invalid.time.start=-1;await assert.rejects(save(h,p,[invalid]),/Times must be numeric/);
  invalid.time.start=0;invalid.time.end=8;await assert.rejects(save(h,p,[invalid]),/within this clip/);
  invalid.time.end=7.5;invalid.time.outcome_observed_at=60;await assert.rejects(save(h,p,[invalid]),/Times must be numeric/);
});

test('legacy source-video times migrate once on reopen and old file import without changing clip boundaries',async()=>{
  const h=harness({duration:100}),video=new File(['v'],'legacy-clips.mp4');
  const p=await h.store.createClipProject(video,'Doctor');
  const oldLabel=record();oldLabel.time={start:42,end:49.5,outcome_observed_at:52};oldLabel.O.evidence_interval=[49.5,52];
  const old={...p,frames:[{id:1,clip_id:'clip_001',start:42,end:49.5,labels:[oldLabel],reviewed:true}],nextClipId:2};delete old.event_time_reference;
  await new Promise((resolve,reject)=>{const r=h.db.open('talktosim-framelab-v1',2);r.onsuccess=()=>{const tx=r.result.transaction('projects','readwrite');tx.objectStore('projects').put(old);tx.oncomplete=()=>{r.result.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  const read=()=>h.store.request(`/api/projects/${p.id}`);
  for(let i=0;i<2;i++){const migrated=await read();assert.equal(migrated.frames[0].start,42);assert.equal(migrated.frames[0].reviewed,true);assert.deepEqual(plain(migrated.frames[0].labels[0].time),{start:0,end:7.5,outcome_observed_at:10});assert.deepEqual(plain(migrated.frames[0].labels[0].O.evidence_interval),[7.5,10]);}
  const restored=await h.store.importProgress(new Blob([JSON.stringify({format:'talktosim-progress',project:old})]),video,'Doctor');
  assert.deepEqual(plain(restored.frames[0].labels[0].time),{start:0,end:7.5,outcome_observed_at:10});
  assert.equal(restored.frames[0].labels[0].Z.xxx,'Custom intention');
});
