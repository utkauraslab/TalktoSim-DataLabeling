/* Selection vocabularies and annotation validation for the PDF workspace. */
(() => {
  const options={action:['Tension','Exposure','Dissection','Cutting','Coagulation','Clipping','Suturing','Irrigation','Suction','Inspection'],tool:['Grasper','Dissector','Scissors','Hook','Bipolar forceps','Clip applier','Needle holder','Suction irrigator'],tissue:['Gallbladder','Liver','Cystic duct','Cystic artery','Connective tissue','Fat','Peritoneum','Blood vessel']};
  const needsRegions=action=>['tension','exposure'].includes(String(action).trim().toLowerCase());
  function validate(value,duration){
    const result={};
    for(const key of ['action','tool','tissue']){if(typeof value[key]!=='string'||value[key].length>200)throw Error('Choose one option for each label (maximum 200 characters).');result[key]=value[key].trim();}
    if(value.region){
      const r=value.region;
      if(!Number.isFinite(r.timestamp)||r.timestamp<0||r.timestamp>duration||!Number.isInteger(r.width)||r.width<=0||!Number.isInteger(r.height)||r.height<=0)throw Error('Invalid annotation frame.');
      result.region={timestamp:r.timestamp,width:r.width,height:r.height,goal:[],avoid:[]};
      for(const type of ['goal','avoid']){
        if(!Array.isArray(r[type])||r[type].length>100)throw Error('Too many region polygons.');
        result.region[type]=r[type].map(points=>{
          if(!Array.isArray(points)||points.length<3||points.length>200||points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||n<0||n>1)))throw Error('A region needs at least three valid points.');
          let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a[0]*b[1]-b[0]*a[1];}if(Math.abs(area)<.000001)throw Error('Choose points that enclose an area.');
          return structuredClone(points);
        });
      }
    }
    return result;
  }
  window.doctorModel={options,needsRegions,validate};
})();
