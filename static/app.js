const $ = id => document.getElementById(id);
let project = null, current = 0, revision = 0, savedRevision = 0, saving = null;
let saveTimer, pollTimer, toastTimer, navigating = false, uploading = false;
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
const pathValue = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
function normalizeLabel(value) {
  if (value.X) return value;
  return {class:value.class || '', event_id:value.event_id || '', time:{},
    X:{instrument:value.instrument || ''}, Y:{action:value.action || ''}, T:{anatomy:value.target || ''},
    Z:{intended_goal:value.intention || ''}, O:{observed_effect:value.outcome || '', evidence_interval:[]}};
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error || `Request failed (${response.status})`); }
  return response.json();
}
function show(view) { for (const name of ['welcome', 'processing', 'editor']) $(name).hidden = name !== view; window.scrollTo(0, 0); }
function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`; }
async function refreshProjects() {
  const projects = await api('/api/projects');
  $('projectCount').textContent = projects.length;
  $('projects').replaceChildren(...projects.map(p => {
    const button = document.createElement('button'); button.className = 'project-item' + (project?.id === p.id ? ' current' : '');
    button.append(document.createTextNode(p.name)); const detail = document.createElement('small');
    detail.textContent = `${{ready:'Ready to annotate', processing:'Extracting frames', error:'Extraction failed'}[p.status]} · ${new Date(p.created_at).toLocaleDateString('en-US')}`;
    button.append(detail); button.onclick = () => guarded(() => openProject(p.id)); return button;
  }));
}
async function guarded(action) {
  if (navigating || uploading) return;
  navigating = true;
  try { await save(); await action(); } catch (err) { toast(err.message); } finally { navigating = false; }
}
async function openProject(id) {
  clearTimeout(pollTimer); project = await api(`/api/projects/${id}`);
  localStorage.setItem('framelab-project', id); $('breadcrumb').textContent = project.name;
  await refreshProjects();
  if (project.status !== 'ready') { show('processing'); poll(); return; }
  show('editor'); $('projectName').textContent = project.name;
  $('projectInfo').textContent = `${project.frames.length} frames · 1 frame every ${project.interval} s · ${project.width} × ${project.height} · Duration ${formatTime(project.duration)}`;
  $('editorAnnotator').value = project.annotator;
  $('onlyPending').checked = false;
  current = Math.max(0, project.frames.findIndex(f => !f.reviewed));
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
  const value = normalizeLabel(raw);
  const group = document.createElement('div'); group.className = 'label-group';
  const head = document.createElement('div'); head.className = 'group-header';
  const title = document.createElement('span'); title.textContent = 'EVENT RECORD';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-label'; remove.textContent = 'Remove';
  remove.onclick = () => { group.remove(); changed(); }; head.append(title, remove); group.append(head);
  function addInput(parent, [path, name, placeholder, type]) {
    const label = document.createElement('label'); label.textContent = name;
    const input = document.createElement('input'); input.dataset.key = path;
    input.type = type || 'text'; input.value = pathValue(value, path) ?? ''; input.placeholder = placeholder; input.maxLength = 2000;
    if (type === 'number') { input.min = '0'; input.max = String(project.duration); input.step = 'any'; }
    label.append(input); parent.append(label);
  }
  const identity = document.createElement('div'); identity.className = 'event-fields';
  addInput(identity, ['class', 'Class *', 'anatomical_exposure']);
  addInput(identity, ['event_id', 'Event ID', `frame_${String(current + 1).padStart(6, '0')}_event_01`]);
  group.append(identity);
  for (const [letter, title, inputs] of eventSections) {
    const section = document.createElement('div'); section.className = 'event-section';
    const heading = document.createElement('h3');
    const badge = document.createElement('span'); badge.className = 'section-letter'; badge.textContent = letter;
    heading.append(badge, document.createTextNode(title)); section.append(heading);
    const content = document.createElement('div'); content.className = 'event-fields';
    for (const field of inputs) addInput(content, field);
    section.append(content); group.append(section);
  }
  group.addEventListener('input', changed); return group;
}
function collect() {
  return [...$('labels').children].map(group => {
    const label = {time:{}, X:{}, Y:{}, T:{}, Z:{}, O:{evidence_interval:[null,null]}};
    for (const input of group.querySelectorAll('input')) {
      const parts = input.dataset.key.split('.'), key = parts.pop();
      const target = parts.reduce((obj, key) => obj[key], label);
      target[key] = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value.trim();
    }
    return label;
  }).filter(label => fieldPaths.some(path => {const value = pathValue(label, path); return value !== '' && value !== null && value !== undefined;}));
}
function changed() {
  revision++; project.frames[current].reviewed = false;
  $('saveStatus').textContent = 'Unsaved…'; $('frameState').textContent = 'Draft'; updateProgress();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(err => { $('saveStatus').textContent = 'Save failed'; toast(err.message); }), 650);
}
async function save() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!project || project.status !== 'ready' || $('editor').hidden || revision === savedRevision) return;
  saving = (async () => {
    while (savedRevision !== revision) {
      const version = revision, frame = project.frames[current], labels = collect();
      if (labels.some(l => !l.class)) throw Error('Add a Class to each annotation, or remove the incomplete event.');
      $('saveStatus').textContent = 'Saving…';
      const result = await api(`/api/projects/${project.id}/frames/${frame.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({labels, reviewed:frame.reviewed, annotator:$('editorAnnotator').value})});
      if (version === revision) Object.assign(frame, result);
      savedRevision = version;
    }
    $('saveStatus').textContent = 'Autosaved'; updateProgress();
  })();
  try { await saving; } finally { saving = null; }
}
function updateProgress() {
  const done = project.frames.filter(f => f.reviewed).length;
  $('completion').textContent = `${done} / ${project.frames.length} frames reviewed`;
  $('annotationProgress').max = project.frames.length; $('annotationProgress').value = done;
}
function visibleIndices() { return project.frames.map((_, i) => i).filter(i => !$('onlyPending').checked || !project.frames[i].reviewed || i === current); }
function renderFrame() {
  revision = savedRevision = 0;
  const frame = project.frames[current];
  $('frameImage').src = `/api/projects/${project.id}/images/${frame.file_name}`;
  $('timestamp').textContent = `${formatTime(frame.timestamp)} / ${formatTime(project.duration)}`;
  $('frameNumber').textContent = `Frame ${current + 1} / ${project.frames.length}`;
  $('frameState').textContent = frame.reviewed ? '✓ Reviewed' : 'Unreviewed / Draft';
  $('labels').replaceChildren(...(frame.labels.length ? frame.labels : [{}]).map(makeGroup));
  $('saveStatus').textContent = 'Saved';
  $('copyPrevious').disabled = current === 0;
  const indices = visibleIndices(), pos = indices.indexOf(current);
  $('prevFrame').disabled = pos <= 0; $('nextFrame').disabled = pos === indices.length - 1;
  const near = indices.slice(Math.max(0, pos - 4), pos + 8);
  $('filmstrip').replaceChildren(...near.map(i => {
    const f = project.frames[i], button = document.createElement('button'); button.className = 'frame-thumb' + (i === current ? ' current' : '') + (f.reviewed ? ' done' : '');
    const img = document.createElement('img'); img.src = `/api/projects/${project.id}/images/${f.file_name}`; img.alt = `Frame ${i + 1}`; img.loading = 'lazy';
    const caption = document.createElement('span'); caption.textContent = formatTime(f.timestamp); button.append(img, caption);
    button.onclick = () => guarded(async () => {current = i; renderFrame();}); return button;
  })); updateProgress(); window.scrollTo(0, 0);
}
function move(direction) { return guarded(async () => { const indices = visibleIndices(), next = indices[indices.indexOf(current) + direction]; if (next !== undefined) { current = next; renderFrame(); } }); }
async function complete() {
  await guarded(async () => {
    const labels = collect();
    if (labels.some(label => fieldPaths.some(path => {const value = pathValue(label, path); return value === '' || value === null || value === undefined;}))) throw Error('Fill in Class, Event ID, all times, and all semantic fields before marking complete.');
    project.frames[current].reviewed = true; revision++;
    try { await save(); } catch (err) { project.frames[current].reviewed = false; throw err; }
    const next = project.frames.findIndex((f, i) => i > current && (!$('onlyPending').checked || !f.reviewed));
    if (next >= 0) {current = next; renderFrame();} else { renderFrame(); toast('Frame complete. Continue reviewing or export your dataset.'); }
  });
}
$('newProject').onclick = () => guarded(async () => { clearTimeout(pollTimer); project = null; localStorage.removeItem('framelab-project'); $('breadcrumb').textContent = 'New project'; show('welcome'); await refreshProjects(); });
$('backFromError').onclick = () => $('newProject').click();
$('prevFrame').onclick = () => move(-1); $('nextFrame').onclick = () => move(1);
$('addLabel').onclick = () => { $('labels').append(makeGroup()); $('labels').lastChild.querySelector('input').focus(); };
$('copyPrevious').onclick = () => { $('labels').replaceChildren(...(project.frames[current - 1].labels.length ? project.frames[current - 1].labels : [{}]).map(makeGroup)); changed(); };
$('completeFrame').onclick = complete;
$('editorAnnotator').oninput = () => { localStorage.setItem('framelab-annotator', $('editorAnnotator').value); changed(); };
$('onlyPending').onchange = () => guarded(async () => { if ($('onlyPending').checked && project.frames[current].reviewed) { const next = project.frames.findIndex(f => !f.reviewed); if (next >= 0) current = next; else toast('All frames have been reviewed.'); } renderFrame(); });
$('exportButton').onclick = () => guarded(async () => $('exportDialog').showModal());
async function download(format) {
  const button = $({zip:'exportZip', json:'exportJson', events:'exportEvents'}[format]); button.disabled = true; button.textContent = 'Preparing export…';
  try {
    // Navigate through a temporary anchor so large ZIPs stream to disk rather than a JS Blob.
    const scope = $('exportScope').value;
    if (scope === '1' && !project.frames.some(f => f.reviewed)) throw Error('No reviewed frames yet. Complete an annotation first.');
    const a = document.createElement('a'); a.href = `/api/projects/${project.id}/export?format=${format}&reviewed=${scope}`; a.download = ''; document.body.append(a); a.click(); a.remove(); toast('Export started. Check your browser downloads.');
  } catch (err) { toast(err.message); } finally { button.disabled = false; button.textContent = {zip:'↓ Images + JSON (ZIP)', json:'Dataset JSON only', events:'Event JSON only'}[format]; }
}
$('exportEvents').onclick = () => download('events'); $('exportJson').onclick = () => download('json'); $('exportZip').onclick = () => download('zip');
document.addEventListener('keydown', event => {
  if ($('editor').hidden || $('exportDialog').open || $('exampleDialog').open) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); complete(); return;}
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
});
window.addEventListener('beforeunload', event => { if (revision !== savedRevision || uploading) { event.preventDefault(); event.returnValue = ''; } });
function updateFile() { const file = $('video').files[0]; if (file) { $('fileName').textContent = file.name; $('fileMeta').textContent = `${(file.size / 1024**2).toFixed(1)} MB · Video selected`; } }
$('video').onchange = updateFile;
for (const event of ['dragenter','dragover']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.add('dragover');});
for (const event of ['dragleave','drop']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.remove('dragover');});
$('dropzone').addEventListener('drop', e => { if (e.dataTransfer.files.length) { const transfer = new DataTransfer(); transfer.items.add(e.dataTransfer.files[0]); $('video').files = transfer.files; updateFile(); } });
function frequency() { const seconds = Number($('interval').value); $('frequencyHint').textContent = seconds > 0 ? `1 frame every ${seconds} s · About ${Math.round(60 / seconds)} frames / minute` : 'Enter a valid sampling interval'; document.querySelectorAll('[data-interval]').forEach(button => button.classList.toggle('selected', Number(button.dataset.interval) === seconds)); }
document.querySelectorAll('[data-interval]').forEach(button => button.onclick = () => { $('interval').value = button.dataset.interval; frequency(); });
$('interval').oninput = frequency;
$('annotator').value = localStorage.getItem('framelab-annotator') || '';
$('uploadForm').onsubmit = event => {
  event.preventDefault(); if (uploading) return;
  const file = $('video').files[0]; if (!file) return toast('Choose a video first.');
  if (file.size > 20 * 1024**3) return toast('The file exceeds the 20 GB limit.');
  localStorage.setItem('framelab-annotator', $('annotator').value);
  const data = new FormData(); data.append('video', file); data.append('interval', $('interval').value); data.append('annotator', $('annotator').value);
  uploading = true; $('startButton').disabled = true;
  const xhr = new XMLHttpRequest(); xhr.open('POST','/api/projects');
  xhr.upload.onprogress = e => { $('startButton').textContent = e.lengthComputable ? `Uploading ${Math.round(e.loaded / e.total * 100)}%` : 'Uploading…'; };
  xhr.onload = async () => {
    uploading = false; $('startButton').disabled = false; $('startButton').textContent = 'Create project & extract →';
    try { const p = JSON.parse(xhr.responseText); if (xhr.status !== 201) throw Error(p.error || 'Upload failed'); await openProject(p.id); } catch(err) { toast(err.message); }
  };
  xhr.onerror = () => { uploading = false; $('startButton').disabled = false; $('startButton').textContent = 'Create project & extract →'; toast('Connection failed. Check that the local server is running.'); };
  xhr.send(data);
};
(async () => { try { await refreshProjects(); const id = localStorage.getItem('framelab-project'); if (id) await openProject(id); } catch(err) { toast(err.message); } })();

let exampleRecord;
async function showExample() {
  try {
    exampleRecord ??= await api('/static/example.json');
    $('exampleJson').textContent = JSON.stringify(exampleRecord, null, 2);
    $('exampleDialog').showModal();
  } catch (err) { toast(err.message); }
}
document.querySelectorAll('.example-trigger').forEach(button => button.onclick = showExample);
$('downloadExample').onclick = () => {
  const a = document.createElement('a'); a.href = '/static/example.json'; a.download = 'annotation-example.json'; a.click();
};
