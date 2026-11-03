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
const example=JSON.parse(readFileSync(new URL('../static/example.json',import.meta.url),'utf8'));
const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
function harness({db=new IDBFactory(),duration=2,broken=false}={}) {
  const downloads=[],urls=new Map(),locks=new Set(),sampled=[];
  let next=0;
  class Video extends EventTarget {
    current=0;videoWidth=320;videoHeight=240;readyState=2;duration=duration;
    set currentTime(value){this.current=value;queueMicrotask(()=>this.dispatchEvent(new Event('seeked')));}
    get currentTime(){return this.current;}
    load(){if(this.src)queueMicrotask(()=>this.dispatchEvent(new Event(broken?'error':'loadeddata')));}
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
  vm.runInContext(source,context);
  return {store:context.window.frameStore,downloads,sampled,db};
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
