/* Explicit, per-upload authorization. No credential or consent is persisted. */
(() => {
  const REPOSITORY='utkauraslab/TalktoSim-DataLabeling',BRANCH='main';
  const API=`/repos/${REPOSITORY}`,WEB=`https://github.com/${REPOSITORY}`;
  const MAX_FILE_BYTES=50*1024*1024;
  let pending=false;
  function folderName(annotator,date=new Date()) {
    const clean=String(annotator||'').normalize('NFKC').trim().replace(/[^\p{L}\p{N}._-]+/gu,'_').replace(/^[._-]+|[._-]+$/g,'');
    const name=Array.from(clean).slice(0,50).join('');
    if(!name)throw Error('Enter an annotator name before uploading.');
    return `${name}_${date.toISOString().replace(/[:.]/g,'-')}`;
  }
  function sha(value) {
    if(typeof value!=='string'||!/^[a-f0-9]{40,64}$/.test(value))throw Error('GitHub returned an invalid commit reference.');
    return value;
  }
  async function base64(blob) {
    const bytes=new Uint8Array(await blob.arrayBuffer()),chunks=[];
    for(let i=0;i<bytes.length;i+=32768)chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
    return btoa(chunks.join(''));
  }
  async function upload({consent,token,submission,signal,onProgress=()=>{}}={}) {
    // Check before any network request, including account lookup.
    if(consent!==true)throw Error('Upload is optional. Authorize this upload first, or download locally.');
    if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('Provide a GitHub authorization token for this upload.');
    if(pending)throw Error('An upload is already in progress.');
    if(!submission||!Array.isArray(submission.files)||!submission.files.length)throw Error('Prepare the annotation dataset first.');
    const names=new Set();
    for(const file of submission.files) {
      if(!['annotations.json','events.json','clips.json','dataset.zip'].includes(file.name)||!(file.blob instanceof Blob))throw Error('Unsupported submission file.');
      if(names.has(file.name))throw Error('Duplicate submission filename.');names.add(file.name);
      if(file.name==='dataset.zip'&&submission.includeImages!==true)throw Error('Frame images were not authorized for this upload.');
      if(file.blob.size>MAX_FILE_BYTES)throw Error(`${file.name} is larger than 50 MB. Upload labels without images, or download the full ZIP locally.`);
    }
    const timestamp=new Date(),folder=`labeling/${folderName(submission.annotator,timestamp)}`,createdAt=timestamp.toISOString();
    const credential=token.trim();pending=true;
    async function api(path,method='GET',body,allowMissing=false) {
      if(path!=='/user'&&!path.startsWith(`${API}/`)&&path!==API)throw Error('Unexpected upload destination.');
      signal?.throwIfAborted();
      let response;
      try {
        response=await fetch(`https://api.github.com${path}`,{method,mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal,
          headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${credential}`,'X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},
          ...(body?{body:JSON.stringify(body)}:{})});
      }catch(error){if(error.name==='AbortError')throw error;throw Error('Could not reach GitHub. Check your connection; local downloads are still available.');}
      if(response.status===404&&allowMissing)return null;
      if(!response.ok) {
        const messages={401:'GitHub authorization expired or is invalid. Use a new token.',403:'GitHub denied the upload. Your account and token need Contents: read and write access to this repository; organization approval may be required.',404:'The repository or branch is unavailable to this GitHub authorization.',409:'The repository changed during upload. Please try again.',413:'The submission is too large for GitHub. Upload labels only or download locally.',422:'GitHub could not commit this submission. Check repository rules or try again.'};
        const error=Error(messages[response.status]||'GitHub could not complete the upload. Local downloads are still available.');error.status=response.status;throw error;
      }
      return response.json();
    }
    try {
      onProgress('Checking GitHub authorization…');
      const user=await api('/user'),repo=await api(API);
      if(!user.login)throw Error('Could not verify the GitHub account.');
      if(repo.permissions?.push===false)throw Error('This GitHub account does not have write access to the repository. Download locally or request repository access.');
      if(await api(`${API}/contents/${folder.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`,'GET',undefined,true))throw Error('A submission with this name already exists. Try again to create a new timestamp.');
      const metadata={schema_version:'1.0',annotator:submission.annotator,uploaded_at:createdAt,github_account:user.login,
        project_id:submission.projectId,source_video:submission.sourceVideo,unit_type:submission.unitType||'frames',frame_count:submission.frameCount,
        ...(submission.unitType==='clips'?{clip_count:submission.clipCount}:{}),
        annotation_count:submission.annotationCount,reviewed_only:submission.onlyReviewed,images_included:submission.includeImages,
        consent:{granted:true,at:createdAt,destination:REPOSITORY,visibility:repo.private?'private':'public'},
        files:[...submission.files.map(file=>file.name),'submission.json']};
      const files=[...submission.files,{name:'submission.json',blob:new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'})}];
      const entries=[];
      for(let i=0;i<files.length;i++) {
        signal?.throwIfAborted();onProgress(`Uploading ${files[i].name} (${i+1}/${files.length})…`);
        const blob=await api(`${API}/git/blobs`,'POST',{encoding:'base64',content:await base64(files[i].blob)});
        entries.push({path:`${folder}/${files[i].name}`,mode:'100644',type:'blob',sha:sha(blob.sha)});
      }
      // A single atomic commit, with non-forced retries if another annotator advances main.
      for(let attempt=0;attempt<3;attempt++) {
        onProgress('Committing the authorized submission…');
        const ref=await api(`${API}/git/ref/heads/${BRANCH}`),head=sha(ref.object?.sha);
        const parent=await api(`${API}/git/commits/${head}`);
        if(await api(`${API}/contents/${folder.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`,'GET',undefined,true))throw Error('This submission folder already exists. It will not be overwritten.');
        const tree=await api(`${API}/git/trees`,'POST',{base_tree:sha(parent.tree?.sha),tree:entries});
        const commit=await api(`${API}/git/commits`,'POST',{message:`Add labeling: ${String(submission.annotator).replace(/[\r\n]/g,' ')} (${createdAt})`,tree:sha(tree.sha),parents:[head]});
        try {
          await api(`${API}/git/refs/heads/${BRANCH}`,'PATCH',{sha:sha(commit.sha),force:false});
          return {folder,url:`${WEB}/tree/${BRANCH}/${folder.split('/').map(encodeURIComponent).join('/')}`,commit:commit.sha,githubAccount:user.login,uploadedAt:createdAt};
        }catch(error){if(![409,422].includes(error.status)||attempt===2)throw error;}
      }
    }finally{pending=false;}
  }
  window.githubUpload={upload,folderName,repository:REPOSITORY,maxFileBytes:MAX_FILE_BYTES};
})();
