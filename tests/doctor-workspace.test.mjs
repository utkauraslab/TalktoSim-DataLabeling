import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../static/doctor-workspace.js',import.meta.url),'utf8');
function setup(denied=false){
  let stopped=0;const saved=[];let resolveSaved;
  const finished=new Promise(r=>resolveSaved=r);
  class Recorder {
    static isTypeSupported(t){return t.includes('webm');}
    constructor(){this.mimeType='audio/webm';this.state='inactive';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable({data:new Blob(['recorded-audio'],{type:this.mimeType})});this.onstop();}
  }
  const context=vm.createContext({window:{},document:{},navigator:{mediaDevices:{getUserMedia:async()=>{if(denied)throw Object.assign(Error('denied'),{name:'NotAllowedError'});return {getTracks:()=>[{stop(){stopped++;}}]};}}},MediaRecorder:Recorder,Blob,setTimeout,clearTimeout});
  vm.runInContext(source,context);
  const w=Object.create(context.window.DoctorWorkspace.prototype);w.changed=()=>{};w.persist=async(c,blobs)=>{saved.push(blobs);};w.renderAudio=async()=>{resolveSaved();};w.onError=()=>{};
  const button={classList:{add(){},remove(){}},textContent:''};
  return {w,button,saved,finished,stopped:()=>stopped};
}
test('audio recording locks clip navigation, saves binary audio on Stop and releases microphone tracks',async()=>{
  const h=setup();await h.w.startRecording('goal',h.button);assert.equal(h.button.textContent,'■ Stop recording');
  await assert.rejects(h.w.flush(),/Stop the recording/);await assert.rejects(h.w.startRecording('outcome',h.button),/Finish the current/);
  h.button.onclick();await h.finished;await Promise.resolve();assert.equal(h.stopped(),1);assert.equal(await h.saved[0].goal.text(),'recorded-audio');assert.equal(h.w.recording,null);
});
test('microphone refusal gives an actionable message without fabricating a recording',async()=>{
  const h=setup(true);await assert.rejects(h.w.startRecording('goal',h.button),/Microphone permission was denied/);assert.equal(h.saved.length,0);assert.equal(h.w.startingRecording,false);assert.equal(h.w.recording,null);
});
