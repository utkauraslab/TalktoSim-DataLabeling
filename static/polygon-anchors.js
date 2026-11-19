/* Pointer editing in image-normalized coordinates. Existing geometry changes only on drop. */
(() => {
  class PolygonAnchors {
    constructor(canvas,{getShapes,onPreview,onCommit,onError}){
      Object.assign(this,{canvas,getShapes,onPreview,onCommit,onError});this.drag=null;this.suppressClick=false;
      canvas.addEventListener('pointerdown',e=>this.down(e));
      canvas.addEventListener('pointermove',e=>this.move(e));
      canvas.addEventListener('pointerup',e=>this.up(e));
      for(const event of ['pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>this.cancel(e));
    }
    position(e){const r=this.canvas.getBoundingClientRect();if(!r.width||!r.height)return this.drag?.point||[0,0];return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
    hit(e){
      const r=this.canvas.getBoundingClientRect(),radius=e.pointerType==='touch'?22:12;
      if(!r.width||!r.height)return null;
      let nearest=null,distance=radius;
      // Prefer the current draft when handles overlap, otherwise pick the nearest vertex.
      for(const shape of [...this.getShapes()].reverse())for(let vertex=0;vertex<shape.points.length;vertex++){
        const [x,y]=shape.points[vertex],d=Math.hypot(e.clientX-(r.left+x*r.width),e.clientY-(r.top+y*r.height));
        if(d<distance){distance=d;nearest={kind:shape.kind,type:shape.type,polygon:shape.polygon,vertex,original:[x,y],point:[x,y]};}
      }
      return nearest;
    }
    down(e){
      if(this.drag||e.isPrimary===false||(e.button!==undefined&&e.button!==0))return;
      clearTimeout(this.clickTimer);this.suppressClick=false;const hit=this.hit(e);if(!hit)return;
      e.preventDefault();this.suppressClick=true;
      this.drag={...hit,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,moved:false};this.canvas.style.cursor='grabbing';this.canvas.focus({preventScroll:true});
      this.canvas.setPointerCapture(e.pointerId);this.onPreview();
    }
    move(e){
      if(!this.drag){this.canvas.style.cursor=this.hit(e)?'grab':'crosshair';return;}
      if(e.pointerId!==this.drag.pointerId)return;
      e.preventDefault();if(Math.hypot(e.clientX-this.drag.startX,e.clientY-this.drag.startY)>3)this.drag.moved=true;if(!this.drag.moved)return;this.drag.point=this.position(e);this.onPreview();
    }
    async up(e){
      if(!this.drag||e.pointerId!==this.drag.pointerId)return;
      e.preventDefault();const drag=this.drag;if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>3)drag.moved=true;if(drag.moved)drag.point=this.position(e);this.drag=null;
      this.release(e.pointerId);this.canvas.style.cursor='grab';
      // The compatibility click after pointerup must never add an extra vertex.
      this.clickTimer=setTimeout(()=>{this.suppressClick=false;},350);
      try{if(drag.moved&&Math.hypot(drag.point[0]-drag.original[0],drag.point[1]-drag.original[1])>1e-8)await this.onCommit(drag);}
      catch(error){this.onError(error);}finally{this.onPreview();}
    }
    cancel(e){
      if(!this.drag||(e?.pointerId!==undefined&&e.pointerId!==this.drag.pointerId))return;
      const id=this.drag.pointerId;this.drag=null;clearTimeout(this.clickTimer);this.suppressClick=true;this.clickTimer=setTimeout(()=>{this.suppressClick=false;},350);this.release(id);this.canvas.style.cursor='crosshair';this.onPreview();
    }
    release(id){if(this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id);}
    preview(points,type,kind,polygon){
      const drag=this.drag;
      if(!drag||drag.kind!==kind||drag.type!==type||drag.polygon!==polygon)return points;
      return points.map((point,i)=>i===drag.vertex?drag.point:point);
    }
  }
  window.PolygonAnchors=PolygonAnchors;
})();
