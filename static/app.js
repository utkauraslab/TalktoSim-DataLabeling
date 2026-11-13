const $ = id => document.getElementById(id);
let project = null, current = 0, revision = 0, savedRevision = 0, saving = null;
let saveTimer, pollTimer, toastTimer, navigating = false, uploading = false, timeline;
const isClipProject=()=>project?.kind==='clips';
const unit=()=>isClipProject()?'clip':'frame';
const eventSections = [
  ['TIME', 'Event timing · seconds', [
    ['time.start', 'Start', '42.0', 'number'], ['time.end', 'End', '49.5', 'number'],
    ['time.outcome_observed_at', 'Outcome observed at', '52.0', 'number']]],
  ['X', 'Instrument', [['X.instrument', 'Instrument', 'grasper']]],
  ['Y', 'Action', [['Y.action', 'Action', 'retract'], ['Y.direction', 'Direction', 'superolateral']]],
  ['T', 'Target anatomy', [['T.anatomy', 'Anatomy', 'gallbladder'], ['T.region', 'Region', 'fundus']]],
  ['Z', 'Intention', [['Z.intended_goal', 'Intended goal', 'expose hepatocystic triangle'],
    ['Z.goal_type', 'Goal type', 'anatomical_exposure'], ['Z.source', 'Intention source', 'surgeon_verified']]],
  ['O', 'Outcome', [['O.observed_effect', 'Observed effect', 'increased_anatomical_visibility'],
    ['O.goal_achieved', 'Goal achieved', 'partial'], ['O.evidence_interval.0', 'Evidence start (s)', '49.5', 'number'],
    ['O.evidence_interval.1', 'Evidence end (s)', '52.0', 'number'], ['O.source', 'Outcome source', 'video_and_expert']]]
];
const fieldPaths = ['class', 'event_id', ...eventSections.flatMap(section => section[2].map(field => field[0]))];
const classChoices = [
  ['anatomical_exposure', 'Anatomical exposure'], ['tissue_manipulation', 'Tissue manipulation'],
  ['tension', 'Tension'],
  ['dissection', 'Dissection'], ['cutting', 'Cutting'], ['coagulation', 'Coagulation'],
  ['clipping', 'Clipping'], ['suturing', 'Suturing'], ['irrigation', 'Irrigation'],
  ['suction', 'Suction'], ['inspection', 'Inspection']
];
const semanticGroups = ['X', 'Y', 'T', 'Z', 'O'];
const standardKeys = Object.fromEntries(eventSections.filter(s => s[0] !== 'TIME').map(([letter, , fields]) =>
  [letter, new Set(fields.map(field => field[0].split('.')[1]))]));
const pathValue = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
function normalizeLabel(value) {
  if (value.X) return value;
  return {class:value.class || '', event_id:value.event_id || '', time:{},
    X:{instrument:value.instrument || ''}, Y:{action:value.action || ''}, T:{anatomy:value.target || ''},
    Z:{intended_goal:value.intention || ''}, O:{observed_effect:value.outcome || '', evidence_interval:[]}};
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(url, options = {}) {
  if (url.startsWith('/api/')) return frameStore.request(url, options);
  const response = await fetch(url, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error || `Request failed (${response.status})`); }
  return response.json();
}
function show(view) { document.querySelectorAll('video').forEach(video=>video.pause()); for (const name of ['welcome', 'segmenter', 'processing', 'editor']) $(name).hidden = name !== view; window.scrollTo(0, 0); }
function formatTime(seconds) { return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`; }
async function refreshProjects() {
  const projects = await api('/api/projects');
  $('projectCount').textContent = projects.length;
  $('projects').replaceChildren(...projects.map(p => {
    const button = document.createElement('button'); button.className = 'project-item' + (project?.id === p.id ? ' current' : '');
    button.append(document.createTextNode(p.name)); const detail = document.createElement('small');
    detail.textContent = `${{ready:'Ready to annotate', segmenting:'Continue splitting', processing:'Extracting frames', error:'Needs attention'}[p.status]} · ${new Date(p.created_at).toLocaleDateString('en-US')}`;
    button.append(detail); button.onclick = () => guarded(() => openProject(p.id)); return button;
  }));
}
async function guarded(action) {
  if (navigating || uploading) return;
  navigating = true;
  try { if(!$('segmenter').hidden)await timeline.flush(); await save(); await action(); } catch (err) { toast(err.message); } finally { navigating = false; }
}
async function openSegmentation(p) {
  project=p;show('segmenter');await timeline.open(p);
}
async function openProject(id) {
  clearTimeout(pollTimer); project = await api(`/api/projects/${id}`);
  localStorage.setItem('framelab-project', id); $('breadcrumb').textContent = project.name;
  await refreshProjects();
  if(project.kind==='clips'&&(project.status==='segmenting'||!project.frames.length)){await openSegmentation(project);return;}
  if (project.status !== 'ready') { show('processing'); poll(); return; }
  show('editor'); $('projectName').textContent = project.name;
  $('projectInfo').textContent = isClipProject()
    ? `${project.frames.length} clips · Duration ${formatTime(project.duration)} · ${project.width} × ${project.height}`
    : `${project.frames.length} frames · Legacy frame project · ${project.width} × ${project.height}`;
  $('editorAnnotator').value = project.annotator;$('onlyPending').checked = false;
  current = Math.max(0, project.frames.findIndex(f => !f.reviewed));
  $('editClips').hidden=!isClipProject();$('downloadProgress').hidden=!isClipProject();$('finishProject').hidden=!isClipProject();$('saveClip').hidden=!isClipProject();$('legacyViewer').hidden=isClipProject();$('clipViewer').hidden=!isClipProject();$('clipJumpLabel').hidden=!isClipProject();
  if(isClipProject())await frameStore.attachVideo($('clipVideo'),project.id);
  renderFrame();
}
async function poll() {
  try {
    project = await api(`/api/projects/${project.id}`);
    $('backFromError').hidden = project.status !== 'error';
    document.querySelector('.spinner').hidden = project.status === 'error';
    if (project.status === 'ready') { await openProject(project.id); return; }
    if (project.status === 'error') { $('processingTitle').textContent = 'Extraction failed'; $('processingDetail').textContent = project.error; await refreshProjects(); return; }
    $('processingTitle').textContent = 'Extracting video frames';
    const estimate = project.duration ? Math.ceil(project.duration / project.interval) : null;
    $('processingDetail').textContent = `Extracted ${project.extracted} frames${estimate ? ` / estimated ${estimate} frames` : ' · Reading video…'}`;
    if (estimate) { $('extractProgress').max = estimate; $('extractProgress').value = project.extracted; }
    else $('extractProgress').removeAttribute('value');
    pollTimer = setTimeout(poll, 1000);
  } catch (err) { toast(err.message); pollTimer = setTimeout(poll, 3000); }
}
function makeGroup(raw = {}) {
  const value = normalizeLabel(structuredClone(raw));
  if(isClipProject()&&!Object.hasOwn(raw,'time'))value.time=clipModel.timingDefaults(project.frames[current]);
  const group = document.createElement('div'); group.className = 'label-group';
  const head = document.createElement('div'); head.className = 'group-header';
  const title = document.createElement('span'); title.textContent = 'EVENT RECORD';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-label'; remove.textContent = 'Remove';
  remove.onclick = () => { group.remove(); changed(); }; head.append(title, remove); group.append(head);
  function addInput(parent, [path, name, placeholder, type]) {
    const label = document.createElement('label'); label.textContent = name;
    const input = document.createElement('input'); input.dataset.key = path;
    input.type = type || 'text'; input.value = pathValue(value, path) ?? ''; input.placeholder = isClipProject()&&path.startsWith('time.')?String(clipModel.timingDefaults(project.frames[current])[path.split('.')[1]]):placeholder; input.maxLength = 2000;
    if (type === 'number') { input.min='0'; input.max=String(isClipProject()?(['time.start','time.end'].includes(path)?clipModel.clipDuration(project.frames[current]):Number((project.duration-project.frames[current].start).toFixed(6))):project.duration); input.step='any'; }
    label.append(input); parent.append(label);
  }
  const identity = document.createElement('div'); identity.className = 'event-fields';
  const classLabel = document.createElement('label'); classLabel.textContent = 'Class *';
  const classSelect = document.createElement('select'); classSelect.className = 'class-select';
  classSelect.setAttribute('aria-label', 'Class *');
  const options = new Map(classChoices);
  for (const frame of project.frames) for (const annotation of frame.labels) {
    if (annotation.class && !options.has(annotation.class)) options.set(annotation.class, annotation.class);
  }
  if (value.class && !options.has(value.class)) options.set(value.class, value.class);
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a class…';
  classSelect.append(placeholder);
  for (const [key, name] of options) {
    const option = document.createElement('option'); option.value = key; option.textContent = name; classSelect.append(option);
  }
  const other = document.createElement('option'); other.value = ''; other.textContent = 'Other — enter your own'; other.dataset.custom = 'true'; classSelect.append(other);
  classSelect.value = value.class || '';
  classLabel.append(classSelect); identity.append(classLabel);
  addInput(identity, ['event_id', 'Event ID', isClipProject()?project.frames[current].clip_id:`frame_${String(current + 1).padStart(6, '0')}_event_01`]);
  const customClassLabel = document.createElement('label'); customClassLabel.className = 'custom-class-label'; customClassLabel.textContent = 'Custom class *'; customClassLabel.hidden = true;
  const customClass = document.createElement('input'); customClass.className = 'custom-class-input'; customClass.placeholder = 'Enter your own class'; customClass.maxLength = 2000;
  customClassLabel.append(customClass); identity.append(customClassLabel);
  classSelect.onchange = () => {
    customClassLabel.hidden = !classSelect.selectedOptions[0]?.dataset.custom;
    if (!customClassLabel.hidden) customClass.focus();
    if(isClipProject()&&(classSelect.value||classSelect.selectedOptions[0]?.dataset.custom)){
      const clip=project.frames[current],index=[...$('labels').children].indexOf(group);
      for(const [path,text]of [['event_id',clip.clip_id+(index>0?`_event_${index+1}`:'')],['time.start',0],['time.end',clipModel.clipDuration(clip)],['time.outcome_observed_at',clipModel.clipDuration(clip)]]){
        const field=group.querySelector(`[data-key="${path}"]`);if(field&&field.value==='')field.value=text;
      }
    }
  };
  group.append(identity);
  for (const [letter, title, inputs] of eventSections) {
    const section = document.createElement('div'); section.className = 'event-section';
    const heading = document.createElement('h3');
    const badge = document.createElement('span'); badge.className = 'section-letter'; badge.textContent = letter;
    heading.append(badge, document.createTextNode(letter==='TIME'&&isClipProject()?'Event timing · clip seconds':title)); section.append(heading);
    if(letter==='TIME'&&isClipProject()){const hint=document.createElement('p');hint.className='hint';hint.textContent=`0 = clip start · Clip length ${clipModel.clipDuration(project.frames[current])} s. Timing is prefilled and editable; verify the outcome time. Outcome and evidence may extend beyond this clip, measured from the same 0.`;section.append(hint);}
    const content = document.createElement('div'); content.className = 'event-fields';
    for (const field of inputs) addInput(content, field);
    section.append(content);
    if (letter !== 'TIME') {
      const custom = document.createElement('div'); custom.className = 'custom-fields'; custom.dataset.group = letter;
      for (const [name, text] of Object.entries(value[letter] || {})) {
        if (!standardKeys[letter].has(name)) custom.append(makeCustomField(letter, name, text));
      }
      const add = document.createElement('button'); add.type = 'button'; add.className = 'add-custom-field'; add.textContent = '+ Other · Add a custom field';
      add.onclick = () => {
        if (custom.children.length >= 50) return toast('Each section supports up to 50 custom fields.');
        const row = makeCustomField(letter); custom.append(row); row.querySelector('input').focus();
      };
      section.append(custom, add);
    }
    group.append(section);
  }
  group.addEventListener('input', changed); return group;
}
function makeCustomField(letter, name = '', value = '') {
  const row = document.createElement('div'); row.className = 'custom-field-row';
  for (const [key, title, text, placeholder, limit] of [
    ['name', 'Field name', name, 'e.g. xxx', 80], ['value', 'Field value', value, 'Enter a value', 2000]
  ]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.className = `custom-field-${key}`;
    input.setAttribute('aria-label', `${letter} custom field ${key}`); input.value = text; input.placeholder = placeholder; input.maxLength = limit;
    label.append(input); row.append(label);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-custom-field'; remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove ${letter} custom field`); remove.onclick = () => { row.remove(); changed(); };
  row.append(remove); return row;
}
function collect() {
  return [...$('labels').children].map(group => {
    const label = {...(isClipProject()?{time_reference:'clip'}:{}),time:{}, X:{}, Y:{}, T:{}, Z:{}, O:{evidence_interval:[null,null]}};
    const classSelect = group.querySelector('.class-select');
    label.class = classSelect.selectedOptions[0]?.dataset.custom ? group.querySelector('.custom-class-input').value.trim() : classSelect.value;
    for (const input of group.querySelectorAll('input[data-key]')) {
      const parts = input.dataset.key.split('.'), key = parts.pop();
      const target = parts.reduce((obj, key) => obj[key], label);
      target[key] = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim();
    }
    for (const custom of group.querySelectorAll('.custom-fields')) {
      const letter = custom.dataset.group;
      for (const row of custom.children) {
        const name = row.querySelector('.custom-field-name').value.trim(), value = row.querySelector('.custom-field-value').value.trim();
        if (!name && !value) continue;
        if (!name) throw Error(`${letter}: name your custom field before saving.`);
        if (name.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(label[letter], name)) {
          throw Error(`${letter}: use a unique field name that differs from the standard fields.`);
        }
        label[letter][name] = value;
      }
    }
    return label;
  }).filter(label => fieldPaths.some(path => {const value = pathValue(label, path); return value !== '' && value !== null && value !== undefined;})
    || semanticGroups.some(letter => Object.keys(label[letter]).some(key => !standardKeys[letter].has(key))));
}
function changed() {
  revision++; project.frames[current].reviewed = false;
  project.completed=false; $('saveStatus').textContent = 'Unsaved…'; $('frameState').textContent = 'Draft'; updateProgress();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(err => { $('saveStatus').textContent = 'Save failed'; toast(err.message); }), 650);
}
async function save() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!project || project.status !== 'ready' || $('editor').hidden || revision === savedRevision) return;
  saving = (async () => {
    while (savedRevision !== revision) {
      const version = revision, frame = project.frames[current], labels = collect();
      
      $('saveStatus').textContent = 'Saving…';
      const result = await api(`/api/projects/${project.id}/frames/${frame.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({labels, reviewed:frame.reviewed, annotator:$('editorAnnotator').value})});
      if (version === revision) Object.assign(frame, result);
      savedRevision = version;
    }
    $('saveStatus').textContent = 'Saved locally'; updateProgress();
  })();
  try { await saving; } finally { saving = null; }
}
function updateProgress() {
  const done = project.frames.filter(f => f.reviewed).length;
  $('completion').textContent = `${done} / ${project.frames.length} ${unit()}s reviewed`;
  $('annotationProgress').max = project.frames.length; $('annotationProgress').value = done;
}
function visibleIndices() { return project.frames.map((_, i) => i).filter(i => !$('onlyPending').checked || !project.frames[i].reviewed || i === current); }
function renderFrame() {
  revision = savedRevision = 0;
  const frame = project.frames[current];frameStore.releaseImages();
  if(isClipProject()){
    $('clipVideo').pause();$('reviewFullVideo').checked=false;$('clipVideo').currentTime=frame.start;
    $('clipRange').textContent=`${frame.clip_id} · ${formatTime(frame.start)} – ${formatTime(frame.end)} · ${(frame.end-frame.start).toFixed(2)} s`;
    $('clipJump').replaceChildren(...project.frames.map((clip,i)=>{const option=document.createElement('option');option.value=i;option.textContent=`Clip ${i+1} · ${formatTime(clip.start)} – ${formatTime(clip.end)}${clip.reviewed?' ✓':''}`;return option;}));
    $('clipJump').value=current;
  }else frameStore.attachImage($('frameImage'),project.id,frame.file_name);
  $('timestamp').textContent=`${formatTime(frame.timestamp)} / ${formatTime(project.duration)}`;
  const title=unit()[0].toUpperCase()+unit().slice(1);
  $('frameNumber').textContent=`${title} ${current+1} / ${project.frames.length}`;
  $('frameState').textContent=frame.reviewed?'✓ Reviewed':'Unreviewed / Draft';
  $('annotationHeading').textContent=`${title} annotations`;$('completeFrame').textContent=isClipProject()?'✓ Save & complete this clip':`✓ Complete & next ${unit()}`;
  $('viewerHint').textContent=isClipProject()?'Label times start at 0 for this clip. The video player and clip boundaries use source-video time. Review full video to inspect later outcomes; subtract the clip start to enter their clip-relative times.':'Legacy frame annotation project. Images retain their original resolution.';
  $('labels').replaceChildren(...(frame.labels.length?frame.labels:[{}]).map(makeGroup));$('saveStatus').textContent='Saved';$('copyPrevious').disabled=current===0;
  const indices=visibleIndices(),pos=indices.indexOf(current);$('prevFrame').disabled=pos<=0;$('nextFrame').disabled=pos===indices.length-1;
  $('filmstrip').replaceChildren(...indices.slice(Math.max(0,pos-4),pos+8).map(i=>{
    const f=project.frames[i],button=document.createElement('button');button.className='frame-thumb'+(isClipProject()?' clip-nav-card':'')+(i===current?' current':'')+(f.reviewed?' done':'');
    if(isClipProject()){const name=document.createElement('strong');name.textContent=`Clip ${i+1}`;button.append(name);}
    else{const img=document.createElement('img');frameStore.attachImage(img,project.id,f.file_name);img.alt=`Frame ${i+1}`;button.append(img);}
    const caption=document.createElement('span');caption.textContent=isClipProject()?`${formatTime(f.start)} – ${formatTime(f.end)}`:formatTime(f.timestamp);button.append(caption);
    button.onclick=()=>guarded(async()=>{current=i;renderFrame();});return button;
  }));updateProgress();window.scrollTo(0,0);
}
function move(direction) { return guarded(async () => { const indices = visibleIndices(), next = indices[indices.indexOf(current) + direction]; if (next !== undefined) { current = next; renderFrame(); } }); }
async function complete() {
  await guarded(async () => {
    const labels = collect();
    if (labels.some(label => fieldPaths.some(path => {const value = pathValue(label, path); return value === '' || value === null || value === undefined;}))) throw Error('Fill in Class, Event ID, all times, and all semantic fields before marking complete.');
    if (labels.some(label => semanticGroups.some(letter => Object.entries(label[letter]).some(([key, value]) => !standardKeys[letter].has(key) && !value)))) throw Error('Fill in every custom field, or remove unused fields before marking complete.');
    project.frames[current].reviewed = true; revision++;
    try { await save(); } catch (err) { project.frames[current].reviewed = false; throw err; }
    const next = project.frames.findIndex((f, i) => i > current && (!$('onlyPending').checked || !f.reviewed));
    if (!isClipProject() && next >= 0) {current = next; renderFrame();} else { renderFrame(); toast('Saved locally. Click Add a clip to continue, or Finish project when you are done.'); }
  });
}
$('newProject').onclick = () => guarded(async () => { clearTimeout(pollTimer); project = null; localStorage.removeItem('framelab-project'); $('breadcrumb').textContent = 'New project'; show('welcome'); await refreshProjects(); });
$('backFromError').onclick = () => $('newProject').click();
$('prevFrame').onclick = () => move(-1); $('nextFrame').onclick = () => move(1);
$('addLabel').onclick = () => { $('labels').append(makeGroup()); $('labels').lastChild.querySelector('input').focus();changed(); };
$('copyPrevious').onclick = () => {
  const previous=structuredClone(project.frames[current-1].labels);
  if(isClipProject())previous.forEach((label,i)=>{label.event_id=project.frames[current].clip_id+(i?`_event_${i+1}`:'');label.time=clipModel.timingDefaults(project.frames[current]);label.time_reference='clip';label.O.evidence_interval=[null,null];});
  $('labels').replaceChildren(...(previous.length?previous:[{}]).map(makeGroup));changed();
};
$('saveClip').onclick=()=>guarded(async()=>{revision++;await save();toast('This clip is saved locally. You can safely return later.');});
$('downloadProgress').onclick=()=>guarded(async()=>{await frameStore.backup(project.id);toast('Progress downloaded. Keep the original video to resume on another browser.');});
$('resumeProject').onclick=async()=>{
  if(uploading)return;uploading=true;$('resumeProject').disabled=true;
  try{const file=$('progressFile').files[0];if(!file)throw Error('Choose a progress JSON first.');const p=await frameStore.importProgress(file,$('resumeVideo').files[0],$('annotator').value);uploading=false;await openProject(p.id);}
  catch(e){toast(e.message);}finally{uploading=false;$('resumeProject').disabled=false;}
};
$('finishProject').onclick=()=>guarded(async()=>{project=await frameStore.finishProject(project.id);configureExport();resetGithubAuthorization();$('exportDialog').showModal();toast('Project finished and saved locally. GitHub upload is optional.');});
$('editClips').onclick=()=>guarded(async()=>openSegmentation(await api(`/api/projects/${project.id}`)));
$('clipJump').onchange=()=>guarded(async()=>{current=Number($('clipJump').value);renderFrame();}).finally(()=>$('clipJump').value=current);
$('playClip').onclick=()=>{const clip=project.frames[current];$('reviewFullVideo').checked=false;$('clipVideo').currentTime=clip.start;$('clipVideo').play().catch(e=>toast(e.message));};
$('clipVideo').addEventListener('timeupdate',()=>{
  if(!isClipProject()||$('editor').hidden||$('reviewFullVideo').checked)return;
  const clip=project.frames[current],video=$('clipVideo');
  if(video.currentTime<clip.start-.05)video.currentTime=clip.start;
  if(video.currentTime>=clip.end){video.pause();if(video.currentTime>clip.end+.01)video.currentTime=clip.end;}
});
$('reviewFullVideo').onchange=()=>{if(!$('reviewFullVideo').checked){$('clipVideo').pause();$('clipVideo').currentTime=project.frames[current].start;}};
$('completeFrame').onclick = complete;
$('editorAnnotator').oninput = () => { localStorage.setItem('framelab-annotator', $('editorAnnotator').value); changed(); };
$('onlyPending').onchange = () => guarded(async () => { if ($('onlyPending').checked && project.frames[current].reviewed) { const next = project.frames.findIndex(f => !f.reviewed); if (next >= 0) current = next; else toast(`All ${unit()}s have been reviewed.`); } renderFrame(); });
$('exportButton').onclick = () => guarded(async () => { configureExport(); resetGithubAuthorization(); $('exportDialog').showModal(); });
function configureExport(){
  $('githubUploadSection').hidden=isClipProject()&&!project.completed;
  $('finishHint').textContent=isClipProject()&&!project.completed?'Work in progress: download locally at any time. Finish project to enable optional GitHub upload.':'';
  const clips=isClipProject();$('includeSourceLabel').hidden=!clips;$('includeSourceVideo').checked=false;$('githubImagesLabel').hidden=clips;
  $('exportScope').options[0].textContent=`All ${unit()}s (including drafts)`;$('exportScope').options[1].textContent=`Reviewed ${unit()}s only`;
  $('githubReviewedOnly').parentElement.lastChild.textContent=` Upload reviewed ${unit()}s only`;
  $('exportDescription').textContent=clips?'Export clip boundaries, event labels, categories and annotator metadata.':'Export a legacy frame dataset with images and labels.';
  $('exportStructure').textContent=clips?'dataset.zip\n├── clips.json · Start / end times\n├── annotations.json · Complete clip dataset\n├── events.json · Event labels\n├── README.txt\n└── source/ · Only if selected below':'dataset.zip\n├── images/\n├── annotations.json\n├── events.json\n└── README.txt';
  $('exportHint').textContent=clips?'Clips are exact time ranges in the source video. Independent trimmed MP4 files are not generated. The source video can be included in your local ZIP only.':'Frame-level semantic annotations with COCO-compatible image tables.';
  $('exportZip').textContent=clips?'↓ Download ZIP':'↓ Images + JSON (ZIP)';
}
let githubBusy=false,githubController=null;
function githubAvailability() {
  const authorized=$('githubConsent').checked;
  $('githubAuthControls').hidden=!authorized;
  $('githubUploadButton').disabled=githubBusy||!authorized||!$('githubToken').value.trim();
  if(!authorized){$('githubToken').value='';githubController?.abort();}
}
function githubPreview() {
  const frames=project?.frames.filter(frame=>!$('githubReviewedOnly').checked||frame.reviewed)||[];
  let destination='Enter an annotator name to generate a folder.';
  try{destination=`labeling/${githubUpload.folderName($('editorAnnotator').value)}/`;}catch{}
  $('githubUploadPreview').textContent=`${frames.length} ${unit()}s · ${frames.reduce((sum,frame)=>sum+frame.labels.length,0)} event records\n${destination}`;
}
function resetGithubAuthorization() {
  githubController?.abort();$('githubToken').value='';$('githubConsent').checked=false;
  $('githubReviewedOnly').checked=true;$('githubIncludeImages').checked=false;
  $('githubUploadSection').open=false;$('githubUploadFields').disabled=githubBusy;
  $('githubUploadResult').hidden=true;$('githubUploadResult').removeAttribute('href');
  $('githubUploadStatus').textContent='Not authorized. Your data stays on this browser; local downloads remain available.';
  githubPreview();githubAvailability();
}
$('githubConsent').onchange=()=>{
  githubAvailability();
  $('githubUploadStatus').textContent=$('githubConsent').checked?'Ready for your GitHub authorization token. Nothing has been uploaded.':'Not authorized. Local downloads remain available.';
};
$('githubToken').oninput=githubAvailability;
for(const id of ['githubReviewedOnly','githubIncludeImages'])$(id).onchange=()=>{
  $('githubConsent').checked=false;githubAvailability();githubPreview();
  $('githubUploadStatus').textContent='Upload options changed. Authorize the selected data before uploading.';
};
$('exportDialog').addEventListener('close',()=>{
  githubController?.abort();$('githubToken').value='';$('githubConsent').checked=false;githubAvailability();
});
$('githubUploadButton').onclick=async()=>{
  if(githubBusy||!$('githubConsent').checked)return;
  const token=$('githubToken').value.trim();if(!token)return;
  $('githubToken').value='';githubBusy=true;githubController=new AbortController();
  const controller=githubController,options={onlyReviewed:$('githubReviewedOnly').checked,includeImages:$('githubIncludeImages').checked};
  $('githubUploadFields').disabled=true;$('githubUploadButton').disabled=true;$('githubUploadResult').hidden=true;
  const status=message=>{$('githubUploadStatus').textContent=message;};
  try{
    await save();controller.signal.throwIfAborted();status('Preparing the authorized labeling data…');
    const submission=await frameStore.prepareSubmission(project.id,options,count=>status(`Preparing ${count} files…`));
    controller.signal.throwIfAborted();
    const result=await githubUpload.upload({consent:true,token,submission,signal:controller.signal,onProgress:status});
    status(`Uploaded as ${result.folder}. Authorized GitHub account: ${result.githubAccount}.`);
    $('githubUploadResult').href=result.url;$('githubUploadResult').hidden=false;toast('Labeling uploaded to GitHub.');
  }catch(error){
    status(error.name==='AbortError'?'Upload canceled. Check the repository if the commit had already started.':error.message);
  }finally{
    githubBusy=false;githubController=null;$('githubUploadFields').disabled=false;
    $('githubToken').value='';$('githubConsent').checked=false;githubAvailability();
  }
};
async function download(format) {
  const button = $({zip:'exportZip', json:'exportJson', events:'exportEvents'}[format]); button.disabled = true; button.textContent = 'Preparing export…';
  try {
    const scope = $('exportScope').value;
    if (scope === '1' && !project.frames.some(f => f.reviewed)) throw Error(`No reviewed ${unit()}s yet. Complete an annotation first.`);
    await frameStore.exportData(project.id, format, scope === '1', count => {
      button.textContent = `Preparing ${count} files…`;
    },{includeVideo:$('includeSourceVideo').checked});
    toast('Export ready. Check your browser downloads.');
  } catch (err) { toast(err.message); } finally { button.disabled = false; button.textContent = {zip:isClipProject()?'↓ Download ZIP':'↓ Images + JSON (ZIP)', json:'Dataset JSON only', events:'Event JSON only'}[format]; }
}
$('exportEvents').onclick = () => download('events'); $('exportJson').onclick = () => download('json'); $('exportZip').onclick = () => download('zip');
document.addEventListener('keydown', event => {
  if ($('editor').hidden || $('exportDialog').open || $('exampleDialog').open) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); complete(); return;}
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
});
window.addEventListener('beforeunload', event => { if (revision !== savedRevision || uploading || githubBusy || timeline?.dirty || project?.status === 'processing') { event.preventDefault(); event.returnValue = ''; } });
function updateFile() { const file = $('video').files[0]; if (file) { $('fileName').textContent = file.name; $('fileMeta').textContent = `${(file.size / 1024**2).toFixed(1)} MB · Video selected`; } }
$('video').onchange = updateFile;
for (const event of ['dragenter','dragover']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.add('dragover');});
for (const event of ['dragleave','drop']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.remove('dragover');});
$('dropzone').addEventListener('drop', e => { if (e.dataTransfer.files.length) { const transfer = new DataTransfer(); transfer.items.add(e.dataTransfer.files[0]); $('video').files = transfer.files; updateFile(); } });
$('annotator').value = localStorage.getItem('framelab-annotator') || '';
$('uploadForm').onsubmit = async event => {
  event.preventDefault(); if (uploading) return;
  const file = $('video').files[0]; if (!file) return toast('Choose a video first.');
  uploading = true; $('startButton').disabled = true; $('startButton').textContent = 'Opening video…';
  try {
    localStorage.setItem('framelab-annotator', $('annotator').value);
    const created = await frameStore.createClipProject(file, $('annotator').value);
    uploading = false; await openProject(created.id);
  } catch(err) { toast(err.message); }
  finally { uploading = false; $('startButton').disabled = false; $('startButton').textContent = 'Open video →'; }
};
$('deleteProject').onclick = () => guarded(async () => {
  if (!confirm('Delete this project and its saved media from this browser? Export a dataset first if you need a copy. This cannot be undone.')) return;
  await frameStore.remove(project.id); project = null; localStorage.removeItem('framelab-project');
  $('breadcrumb').textContent = 'New project'; show('welcome'); await refreshProjects(); toast('Project removed from this browser.');
});
timeline=new ClipTimeline({onConfirm:async p=>{await openProject(p.id);current=project.frames.length-1;renderFrame();},onCancel:async p=>{if(p.frames.length)await openProject(p.id);else{project=null;localStorage.removeItem('framelab-project');$('breadcrumb').textContent='New project';show('welcome');await refreshProjects();}},onError:toast});
(async () => { try { await refreshProjects(); const id = localStorage.getItem('framelab-project'); if (id) { try { await openProject(id); } catch { localStorage.removeItem('framelab-project'); show('welcome'); } } } catch(err) { toast(err.message); } })();

let exampleRecord;
async function showExample() {
  try {
    exampleRecord ??= await api('./static/example.json?v=clip-time-1');
    $('exampleJson').textContent = JSON.stringify(exampleRecord, null, 2);
    $('exampleDialog').showModal();
  } catch (err) { toast(err.message); }
}
document.querySelectorAll('.example-trigger').forEach(button => button.onclick = showExample);
$('downloadExample').onclick = () => {
  const a = document.createElement('a'); a.href = './static/example.json?v=clip-time-1'; a.download = 'annotation-example.json'; a.click();
};
