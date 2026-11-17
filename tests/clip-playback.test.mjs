import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../static/clip-playback.js',import.meta.url),'utf8');
function harness(){
  class Video extends EventTarget {
    currentTime=0;paused=true;muted=false;controls=true;
    pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
    async play(){this.paused=false;this.dispatchEvent(new Event('play'));}
  }
  const element=()=>({value:0,textContent:'',setAttribute(key,value){this[key]=value;}});
  const video=new Video(),range=element(),play=element(),display=element(),mute=element();
  const c=vm.createContext({window:{},document:{}});vm.runInContext(source,c);
  const p=new c.window.ClipPlayback(video,{range,play,display,mute});return {p,video,range,play,display,mute};
}
test('a late source-video clip displays only its own time and maps its entire slider to clip bounds',()=>{
  const h=harness();h.p.setClip({start:2309.75,end:2601.35});
  assert.equal(h.video.controls,false);assert.equal(h.range.min,0);assert.equal(h.range.max,291.6);
  assert.equal(h.video.currentTime,2309.75);assert.equal(h.display.textContent,'00:00:00.00 / 00:04:51.60');
  h.range.value=123.45;h.range.oninput();assert.equal(h.video.currentTime,2433.2);assert.equal(Number(h.range.value).toFixed(2),'123.45');
  assert.equal(h.display.textContent,'00:02:03.45 / 00:04:51.60');assert(!h.display.textContent.includes('38:29'));
  h.range.value=9999;h.range.oninput();assert.equal(h.video.currentTime,2601.35);
  h.range.value=-100;h.range.oninput();assert.equal(h.video.currentTime,2309.75);
});
test('playback stops at the clip end, replays from clip start and clamps external seeking',async()=>{
  const h=harness();h.p.setClip({start:100,end:110});await h.play.onclick();assert.equal(h.video.paused,false);
  h.video.currentTime=111;h.video.dispatchEvent(new Event('timeupdate'));assert.equal(h.video.paused,true);assert.equal(h.video.currentTime,110);
  assert.equal(h.display.textContent,'00:00:10.00 / 00:00:10.00');
  await h.play.onclick();assert.equal(h.video.currentTime,100);assert.equal(h.video.paused,false);
  h.video.currentTime=20;h.video.dispatchEvent(new Event('seeking'));assert.equal(h.video.currentTime,100);
  h.p.clear();assert.equal(h.range.disabled,true);assert.equal(h.video.paused,true);
});
test('switching clips and restoring a region frame reset the range to the new clip reference',()=>{
  const h=harness();h.p.setClip({start:42,end:50},2.4);assert.equal(h.video.currentTime,44.4);assert.equal(h.display.textContent,'00:00:02.40 / 00:00:08.00');
  h.p.setClip({start:3600,end:3600.5});assert.equal(h.video.currentTime,3600);assert.equal(h.range.max,.5);assert.equal(h.display.textContent,'00:00:00.00 / 00:00:00.50');
  h.mute.onclick();assert.equal(h.video.muted,true);assert.equal(h.mute.textContent,'Unmute');
});
