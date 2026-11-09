/* Pure clip partition rules, shared by the timeline and persistent storage. */
(() => {
  const MIN_CLIP=.25,MAX_CLIPS=2000;
  const same=(a,b)=>Math.abs(a-b)<.000001;
  function normalize(cuts,duration) {
    if(!Number.isFinite(duration)||duration<=0)throw Error('The video duration must be positive.');
    if(!Array.isArray(cuts)||cuts.length<2||cuts.length>MAX_CLIPS+1)throw Error(`Choose between 1 and ${MAX_CLIPS} clips.`);
    if(cuts.some(t=>typeof t!=='number'||!Number.isFinite(t)))throw Error('Cut positions must be numeric seconds.');
    const result=cuts.map(t=>Number(t.toFixed(6)));
    if(!same(result[0],0)||!same(result.at(-1),duration))throw Error('Clips must cover the video from start to end.');
    result[0]=0;result[result.length-1]=duration;
    const minimum=Math.min(MIN_CLIP,duration);
    for(let i=1;i<result.length;i++)if(result[i]-result[i-1]<minimum-.000001)throw Error(`Each clip must be at least ${minimum} seconds long.`);
    return result;
  }
  function plan(project,cuts) {
    const valid=normalize(cuts,project.duration),old=project.frames||[];
    let next=project.nextClipId||1;
    for(const clip of old){const n=Number(clip.clip_id?.match(/^clip_(\d+)$/)?.[1]);if(Number.isFinite(n))next=Math.max(next,n+1);}
    const retained=new Set();
    const clips=valid.slice(0,-1).map((start,i)=>{
      const end=valid[i+1],existing=old.find(c=>same(c.start,start)&&same(c.end,end));
      if(existing){retained.add(existing.clip_id);return {...structuredClone(existing),id:i+1};}
      return {id:i+1,clip_id:`clip_${String(next++).padStart(3,'0')}`,start,end,timestamp:start,labels:[],reviewed:false};
    });
    const affected=old.filter(c=>!retained.has(c.clip_id)&&(c.labels.length||c.reviewed));
    return {cuts:valid,clips,nextClipId:next,affectedCount:affected.length};
  }
  window.clipModel={normalize,plan,minClip:MIN_CLIP,maxClips:MAX_CLIPS};
})();
