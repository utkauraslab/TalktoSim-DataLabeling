import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const source=readFileSync(new URL('../static/github-upload.js',import.meta.url),'utf8');
const REPO='/repos/utkauraslab/TalktoSim-DataLabeling',TOKEN='TEST_ONLY_AUTH_1234567890';
const checksum=value=>createHash('sha1').update(value).digest('hex');
class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-11-03T23:30:45.123Z']));}}
function harness({failStatus=0,writable=true,race=false,existing=false}={}) {
  const calls=[],blobs=new Map(),trees=new Map(),commits=new Map();let head='a'.repeat(40),counter=0,raced=false;
  const initialTree='b'.repeat(40);
  trees.set(initialTree,new Map([['README.md','c'.repeat(40)]]));commits.set(head,{tree:initialTree,parents:[]});
  async function fetch(url,options){
    const path=decodeURIComponent(new URL(url).pathname),body=options.body?JSON.parse(options.body):undefined;
    calls.push({url,options,body});
    if(failStatus)return Response.json({message:'not authorized'},{status:failStatus});
    if(path==='/user')return Response.json({login:'expert-a'});
    if(path===REPO)return Response.json({private:false,permissions:{push:writable}});
    if(path.startsWith(`${REPO}/contents/`)) {
      const folder=path.slice(`${REPO}/contents/`.length);
      const found=existing||[...trees.get(commits.get(head).tree).keys()].some(key=>key.startsWith(folder+'/'));
      return Response.json(found?[]:{message:'not found'},{status:found?200:404});
    }
    if(path===`${REPO}/git/blobs`){
      assert.equal(body.encoding,'base64');const bytes=Buffer.from(body.content,'base64'),sha=checksum(bytes);blobs.set(sha,bytes);
      return Response.json({sha},{status:201});
    }
    if(path===`${REPO}/git/ref/heads/main`)return Response.json({object:{sha:head}});
    if(path.startsWith(`${REPO}/git/commits/`))return Response.json({tree:{sha:commits.get(path.split('/').at(-1)).tree}});
    if(path===`${REPO}/git/trees`){
      const tree=new Map(trees.get(body.base_tree));
      for(const entry of body.tree){assert.equal(entry.type,'blob');assert.equal(entry.mode,'100644');assert(blobs.has(entry.sha));tree.set(entry.path,entry.sha);}
      const sha=checksum(`tree-${counter++}`);trees.set(sha,tree);return Response.json({sha},{status:201});
    }
    if(path===`${REPO}/git/commits`){
      const sha=checksum(`commit-${counter++}`);commits.set(sha,{tree:body.tree,parents:body.parents});return Response.json({sha},{status:201});
    }
    if(path===`${REPO}/git/refs/heads/main`){
      assert.equal(body.force,false);
      if(race&&!raced){
        raced=true;const tree=new Map(trees.get(commits.get(head).tree));tree.set('other-annotator.json','d'.repeat(40));
        const treeSha=checksum('concurrent-tree'),commitSha=checksum('concurrent-commit');trees.set(treeSha,tree);commits.set(commitSha,{tree:treeSha,parents:[head]});head=commitSha;
        return Response.json({message:'conflict'},{status:409});
      }
      if(commits.get(body.sha).parents[0]!==head)return Response.json({message:'not fast forward'},{status:422});
      head=body.sha;return Response.json({object:{sha:head}});
    }
    throw Error(`Unexpected route: ${path}`);
  }
  const context=vm.createContext({window:{},Blob,Date:FixedDate,fetch,btoa,Uint8Array,console,
    localStorage:{setItem(){throw Error('Credentials must never be persisted.');}},
    sessionStorage:{setItem(){throw Error('Credentials must never be persisted.');}}});
  vm.runInContext(source,context);
  return {uploader:context.window.githubUpload,calls,blobs,trees,commits,get files(){return trees.get(commits.get(head).tree);}};
}
function submission(){return {annotator:'Alice',projectId:'p1',sourceVideo:'source.mp4',frameCount:1,annotationCount:1,onlyReviewed:true,includeImages:false,
  files:[{name:'annotations.json',blob:new Blob([JSON.stringify({events:[{Z:{xxx:'自定义意图'}}]})],{type:'application/json'})},
    {name:'events.json',blob:new Blob(['[]'],{type:'application/json'})}]};}

test('no account lookup or transmission on script load, absent consent, or absent token',async()=>{
  const h=harness();assert.equal(h.calls.length,0);
  for(const consent of [undefined,false,'true',1])await assert.rejects(h.uploader.upload({consent,token:TOKEN,submission:submission()}),/Authorize|authorize/);
  await assert.rejects(h.uploader.upload({consent:true,token:'',submission:submission()}),/token/);
  assert.equal(h.calls.length,0);
});

test('authorized labels commit atomically under annotator_UTC-time, preserve existing repository contents and never store the token',async()=>{
  const h=harness(),result=await h.uploader.upload({consent:true,token:TOKEN,submission:submission()});
  assert.equal(result.folder,'labeling/Alice_2026-11-03T23-30-45-123Z');
  assert.equal(result.url,'https://github.com/utkauraslab/TalktoSim-DataLabeling/tree/main/'+result.folder);
  assert.equal(h.files.get('README.md'),'c'.repeat(40));assert.equal(h.files.size,4);
  const contents=name=>JSON.parse(h.blobs.get(h.files.get(`${result.folder}/${name}`)).toString('utf8'));
  assert.equal(contents('annotations.json').events[0].Z.xxx,'自定义意图');
  assert.equal(contents('submission.json').annotator,'Alice');assert.equal(contents('submission.json').github_account,'expert-a');
  assert.equal(contents('submission.json').consent.granted,true);assert.equal(contents('submission.json').consent.visibility,'public');
  assert.equal(contents('submission.json').images_included,false);
  assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,1);
  for(const call of h.calls){
    assert.equal(new URL(call.url).origin,'https://api.github.com');assert.equal(call.options.credentials,'omit');
    assert.equal(call.options.redirect,'error');assert.equal(call.options.referrerPolicy,'no-referrer');
    assert.equal(call.options.headers.Authorization,`Bearer ${TOKEN}`);
    assert(!(JSON.stringify(call.body)||'').includes(TOKEN));
  }
  for(const blob of h.blobs.values())assert(!blob.toString('utf8').includes(TOKEN));
});

test('a concurrent annotator update is preserved by a new base tree and non-forced commit retry',async()=>{
  const h=harness({race:true}),result=await h.uploader.upload({consent:true,token:TOKEN,submission:submission()});
  assert(h.files.has('README.md'));assert(h.files.has('other-annotator.json'));assert(h.files.has(`${result.folder}/annotations.json`));
  assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,2);
});

test('existing folder is never overwritten',async()=>{
  const h=harness({existing:true});await assert.rejects(h.uploader.upload({consent:true,token:TOKEN,submission:submission()}),/already exists/);
  assert.equal(h.calls.filter(c=>c.options.method==='POST'||c.options.method==='PATCH').length,0);
});

test('authorization failures and missing repository permission never create blobs or commits',async()=>{
  for(const options of [{failStatus:401},{failStatus:403},{writable:false}]) {
    const h=harness(options);await assert.rejects(h.uploader.upload({consent:true,token:TOKEN,submission:submission()}),/authorization|denied|write access/);
    assert.equal(h.calls.filter(c=>c.options.method!=='GET').length,0);
  }
});

test('images need their own option and oversized files reject before any network call',async()=>{
  const h=harness(),s=submission();s.files.push({name:'dataset.zip',blob:new Blob(['images'])});
  await assert.rejects(h.uploader.upload({consent:true,token:TOKEN,submission:s}),/images were not authorized/);
  assert.equal(h.calls.length,0);
  const LargeBlob=class extends Blob{get size(){return 51*1024*1024;}};
  s.includeImages=true;s.files[2].blob=new LargeBlob(['x']);
  await assert.rejects(h.uploader.upload({consent:true,token:TOKEN,submission:s}),/larger than 50 MB/);
  assert.equal(h.calls.length,0);
});

test('opted-in ZIP is committed alongside JSON, never the source video',async()=>{
  const h=harness(),s=submission();s.includeImages=true;s.files.push({name:'dataset.zip',blob:new Blob(['PK-images'])});
  const result=await h.uploader.upload({consent:true,token:TOKEN,submission:s});
  assert(h.files.has(`${result.folder}/dataset.zip`));assert.equal(h.files.size,5);
  assert(![...h.files.keys()].some(key=>key.endsWith('source.mp4')));
});

test('folder names keep Unicode annotators and exclude path traversal characters',()=>{
  const h=harness(),folder=h.uploader.folderName('../张三 / Alice',new Date('2026-11-03T00:00:00Z'));
  assert.equal(folder,'张三_Alice_2026-11-03T00-00-00-000Z');assert(!folder.includes('/'));
  assert.throws(()=>h.uploader.folderName('....'),/annotator/);
});

test('closing or revoking an upload before its start sends nothing',async()=>{
  const h=harness(),controller=new AbortController();controller.abort();
  await assert.rejects(h.uploader.upload({consent:true,token:TOKEN,submission:submission(),signal:controller.signal}),/abort/i);
  assert.equal(h.calls.length,0);
});
