import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../static/polygon-anchors.js',import.meta.url),'utf8');
const workspaceSource=readFileSync(new URL('../static/doctor-workspace.js',import.meta.url),'utf8');
const modelSource=readFileSync(new URL('../static/doctor-model.js',import.meta.url),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function setup(){
  const shapes=[{kind:'saved',type:'goal',polygon:0,points:[[.2,.2],[.6,.2],[.5,.7]]},{kind:'saved',type:'avoid',polygon:0,points:[[.75,.3],[.9,.3],[.85,.7]]},{kind:'draft',type:'goal',polygon:-1,points:[[.3,.8],[.5,.9]]}];
  class Canvas extends EventTarget {
    style={};captured=new Set();
    getBoundingClientRect(){return {left:40,top:50,width:400,height:200};}
    setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);this.dispatchEvent(Object.assign(new Event('lostpointercapture'),{pointerId:id}));}focus(){}
  }
  const canvas=new Canvas(),commits=[],errors=[];let previews=0;
  const context=vm.createContext({window:{},Math,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout});vm.runInContext(source,context);
  const editor=new context.window.PolygonAnchors(canvas,{getShapes:()=>shapes,onPreview:()=>previews++,onCommit:async drag=>{commits.push(plain(drag));const target=shapes.find(s=>s.kind===drag.kind&&s.type===drag.type&&s.polygon===drag.polygon);target.points[drag.vertex]=[...drag.point];},onError:e=>errors.push(e)});
  const event=(pointerId,x,y,extra={})=>({pointerId,clientX:x,clientY:y,button:0,isPrimary:true,pointerType:'mouse',preventDefault(){},...extra});
  return {editor,canvas,shapes,commits,errors,event,previews:()=>previews};
}
test('dragging a saved anchor previews without mutation, commits normalized coordinates, and keeps the other color unchanged',async()=>{
  const h=setup(),oldAvoid=plain(h.shapes[1]);h.editor.down(h.event(1,120,90));
  assert.equal(h.editor.drag.type,'goal');assert.equal(h.canvas.hasPointerCapture(1),true);
  h.editor.move(h.event(1,200,150));assert.deepEqual(plain(h.editor.preview(h.shapes[0].points,'goal','saved',0)[0]),[.4,.5]);assert.deepEqual(h.shapes[0].points[0],[.2,.2]);
  await h.editor.up(h.event(1,200,150));assert.deepEqual(h.shapes[0].points[0],[.4,.5]);assert.deepEqual(h.shapes[1],oldAvoid);assert.equal(h.commits.length,1);assert.equal(h.editor.suppressClick,true);assert.equal(h.canvas.captured.size,0);
});
test('draft handles can move and an intentional next click is not swallowed after dragging',async()=>{
  const h=setup();h.editor.down(h.event(2,160,210));assert.equal(h.editor.drag.kind,'draft');
  h.editor.move(h.event(2,140,200));await h.editor.up(h.event(2,140,200));assert.deepEqual(h.shapes[2].points[0],[.25,.75]);assert.equal(h.shapes[2].points.length,2);
  h.editor.down(h.event(3,270,170));assert.equal(h.editor.drag,null);assert.equal(h.editor.suppressClick,false);
});
test('a click near an anchor does not move it; cancellation discards preview; out-of-image drops clamp safely',async()=>{
  const h=setup();h.editor.down(h.event(1,125,91));await h.editor.up(h.event(1,125,91));assert.equal(h.commits.length,0);assert.deepEqual(h.shapes[0].points[0],[.2,.2]);
  h.editor.down(h.event(2,120,90));h.editor.move(h.event(2,250,220));h.editor.cancel(h.event(2,250,220));assert.deepEqual(h.shapes[0].points[0],[.2,.2]);assert.equal(h.editor.drag,null);
  h.editor.down(h.event(3,120,90));await h.editor.up(h.event(3,-100,500));assert.deepEqual(h.shapes[0].points[0],[0,1]);
});
test('only the captured pointer moves the selected vertex, including touch hit targets',async()=>{
  const h=setup();h.editor.down(h.event(10,135,90,{pointerType:'touch'}));assert(h.editor.drag);h.editor.move(h.event(11,400,200));assert.deepEqual(plain(h.editor.drag.point),[.2,.2]);await h.editor.up(h.event(11,400,200));assert.equal(h.commits.length,0);h.editor.cancel(h.event(10,135,90));
});
test('workspace saves a dragged saved polygon, keeps draft edits pending, and rejects collapsed geometry without discarding old regions',async()=>{
  const nodes={dwRegionStatus:{}};const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},structuredClone});vm.runInContext(modelSource,c);c.doctorModel=c.window.doctorModel;c.clipModel={clipDuration:()=>10};vm.runInContext(workspaceSource,c);
  const w=Object.create(c.window.DoctorWorkspace.prototype);w.clip={start:0,end:10};w.points=[[.2,.8],[.6,.8]];w.state={action:'Tension',tool:'Grasper',tissue:'Liver',region:{timestamp:2,width:1280,height:720,goal:[[[.2,.2],[.6,.2],[.5,.7]]],avoid:[[[.7,.3],[.9,.3],[.9,.7]]]}};
  let changed=0,saved=0;w.changed=()=>changed++;w.persist=async()=>saved++;w.draw=()=>{};
  await w.commitAnchor({kind:'saved',type:'goal',polygon:0,vertex:0,point:[.1,.4]});assert.equal(saved,1);assert.equal(changed,1);assert.deepEqual(plain(w.state.region.goal[0][0]),[.1,.4]);assert.deepEqual(plain(w.state.region.avoid[0][0]),[.7,.3]);
  await w.commitAnchor({kind:'draft',type:'goal',polygon:-1,vertex:0,point:[.3,.8]});assert.equal(saved,1);assert.deepEqual(w.points[0],[.3,.8]);
  const before=plain(w.state);await assert.rejects(w.commitAnchor({kind:'saved',type:'goal',polygon:0,vertex:0,point:[.6,.2]}),/enclose an area/);assert.deepEqual(plain(w.state),before);assert.equal(saved,1);
});
