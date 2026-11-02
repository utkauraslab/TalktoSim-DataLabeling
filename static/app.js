const $ = id => document.getElementById(id);
let project = null, current = 0, revision = 0, savedRevision = 0, saving = null;
let saveTimer, pollTimer, toastTimer, navigating = false, uploading = false;
const fields = [
  ['instrument', 'X', 'Instrument · 工具 / 器械', '例如：bipolar forceps'],
  ['action', 'Y', 'Action · 动作', '例如：grasping'],
  ['target', 'T', 'Target · 目标', '例如：tissue'],
  ['intention', 'Z', 'Intention · 意图', '例如：stabilize tissue'],
  ['outcome', 'O', 'Outcome · 结果', '例如：tissue stabilized']
];
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error || `请求失败 (${response.status})`); }
  return response.json();
}
function show(view) { for (const name of ['welcome', 'processing', 'editor']) $(name).hidden = name !== view; }
function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`; }
async function refreshProjects() {
  const projects = await api('/api/projects');
  $('projectCount').textContent = projects.length;
  $('projects').replaceChildren(...projects.map(p => {
    const button = document.createElement('button'); button.className = 'project-item' + (project?.id === p.id ? ' current' : '');
    button.append(document.createTextNode(p.name)); const detail = document.createElement('small');
    detail.textContent = `${{ready:'可继续标注', processing:'正在抽帧', error:'抽帧失败'}[p.status]} · ${new Date(p.created_at).toLocaleDateString()}`;
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
  $('projectInfo').textContent = `${project.frames.length} 帧 · 每 ${project.interval} 秒 1 帧 · ${project.width} × ${project.height} · 视频时长 ${formatTime(project.duration)}`;
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
    if (project.status === 'error') { $('processingTitle').textContent = '抽帧未完成'; $('processingDetail').textContent = project.error; await refreshProjects(); return; }
    $('processingTitle').textContent = '正在提取视频帧';
    const estimate = project.duration ? Math.ceil(project.duration / project.interval) : null;
    $('processingDetail').textContent = `已提取 ${project.extracted} 帧${estimate ? ` / 预计 ${estimate} 帧` : ' · 正在读取视频…'}`;
    if (estimate) { $('extractProgress').max = estimate; $('extractProgress').value = project.extracted; }
    else $('extractProgress').removeAttribute('value');
    pollTimer = setTimeout(poll, 1000);
  } catch (err) { toast(err.message); pollTimer = setTimeout(poll, 3000); }
}
function makeGroup(value = {}) {
  const group = document.createElement('div'); group.className = 'label-group';
  const head = document.createElement('div'); head.className = 'group-header';
  const title = document.createElement('span'); title.textContent = '语义标签组';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-label'; remove.textContent = '移除';
  remove.onclick = () => { group.remove(); changed(); }; head.append(title, remove); group.append(head);
  const classField = document.createElement('div'); classField.className = 'class-field';
  const label = document.createElement('label'); label.textContent = 'CLASS · 类别 *';
  const input = document.createElement('input'); input.dataset.key = 'class'; input.value = value.class || ''; input.placeholder = '例如：tissue_manipulation'; input.maxLength = 2000;
  label.append(input); classField.append(label); group.append(classField);
  for (const [key, letter, name, placeholder] of fields) {
    const row = document.createElement('div'); row.className = 'label-row';
    const badge = document.createElement('span'); badge.className = 'letter'; badge.textContent = letter;
    const fieldLabel = document.createElement('label'); fieldLabel.textContent = name;
    const fieldInput = document.createElement('input'); fieldInput.dataset.key = key; fieldInput.value = value[key] || ''; fieldInput.placeholder = placeholder; fieldInput.maxLength = 2000;
    fieldLabel.append(fieldInput); row.append(badge, fieldLabel); group.append(row);
  }
  group.addEventListener('input', changed); return group;
}
function collect() {
  return [...$('labels').children].map(group => Object.fromEntries([...group.querySelectorAll('input')].map(input => [input.dataset.key, input.value.trim()]))).filter(label => Object.values(label).some(Boolean));
}
function changed() {
  revision++; project.frames[current].reviewed = false;
  $('saveStatus').textContent = '待保存…'; $('frameState').textContent = '草稿'; updateProgress();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(err => { $('saveStatus').textContent = '保存失败'; toast(err.message); }), 650);
}
async function save() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!project || project.status !== 'ready' || $('editor').hidden || revision === savedRevision) return;
  saving = (async () => {
    while (savedRevision !== revision) {
      const version = revision, frame = project.frames[current], labels = collect();
      if (labels.some(l => !l.class)) throw Error('请为已填写的标签组补充 Class，或移除该组。');
      $('saveStatus').textContent = '保存中…';
      const result = await api(`/api/projects/${project.id}/frames/${frame.id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({labels, reviewed:frame.reviewed, annotator:$('editorAnnotator').value})});
      if (version === revision) Object.assign(frame, result);
      savedRevision = version;
    }
    $('saveStatus').textContent = '已自动保存'; updateProgress();
  })();
  try { await saving; } finally { saving = null; }
}
function updateProgress() {
  const done = project.frames.filter(f => f.reviewed).length;
  $('completion').textContent = `${done} / ${project.frames.length} 帧已完成`;
  $('annotationProgress').max = project.frames.length; $('annotationProgress').value = done;
}
function visibleIndices() { return project.frames.map((_, i) => i).filter(i => !$('onlyPending').checked || !project.frames[i].reviewed || i === current); }
function renderFrame() {
  revision = savedRevision = 0;
  const frame = project.frames[current];
  $('frameImage').src = `/api/projects/${project.id}/images/${frame.file_name}`;
  $('timestamp').textContent = `${formatTime(frame.timestamp)} / ${formatTime(project.duration)}`;
  $('frameNumber').textContent = `第 ${current + 1} / ${project.frames.length} 帧`;
  $('frameState').textContent = frame.reviewed ? '✓ 已完成' : '待标注 / 草稿';
  $('labels').replaceChildren(...(frame.labels.length ? frame.labels : [{}]).map(makeGroup));
  $('saveStatus').textContent = '已保存';
  $('copyPrevious').disabled = current === 0;
  const indices = visibleIndices(), pos = indices.indexOf(current);
  $('prevFrame').disabled = pos <= 0; $('nextFrame').disabled = pos === indices.length - 1;
  const near = indices.slice(Math.max(0, pos - 4), pos + 8);
  $('filmstrip').replaceChildren(...near.map(i => {
    const f = project.frames[i], button = document.createElement('button'); button.className = 'frame-thumb' + (i === current ? ' current' : '') + (f.reviewed ? ' done' : '');
    const img = document.createElement('img'); img.src = `/api/projects/${project.id}/images/${f.file_name}`; img.alt = `第 ${i + 1} 帧`; img.loading = 'lazy';
    const caption = document.createElement('span'); caption.textContent = formatTime(f.timestamp); button.append(img, caption);
    button.onclick = () => guarded(async () => {current = i; renderFrame();}); return button;
  })); updateProgress();
}
function move(direction) { return guarded(async () => { const indices = visibleIndices(), next = indices[indices.indexOf(current) + direction]; if (next !== undefined) { current = next; renderFrame(); } }); }
async function complete() {
  await guarded(async () => {
    const labels = collect();
    if (labels.some(label => ['class', ...fields.map(f => f[0])].some(k => !label[k]))) throw Error('请填写 Class 和全部五个语义字段，再标记完成。');
    project.frames[current].reviewed = true; revision++;
    try { await save(); } catch (err) { project.frames[current].reviewed = false; throw err; }
    const next = project.frames.findIndex((f, i) => i > current && (!$('onlyPending').checked || !f.reviewed));
    if (next >= 0) {current = next; renderFrame();} else { renderFrame(); toast('已完成当前帧。可继续检查或导出数据集。'); }
  });
}
$('newProject').onclick = () => guarded(async () => { clearTimeout(pollTimer); project = null; localStorage.removeItem('framelab-project'); $('breadcrumb').textContent = '新建项目'; show('welcome'); await refreshProjects(); });
$('backFromError').onclick = () => $('newProject').click();
$('prevFrame').onclick = () => move(-1); $('nextFrame').onclick = () => move(1);
$('addLabel').onclick = () => { $('labels').append(makeGroup()); $('labels').lastChild.querySelector('input').focus(); };
$('copyPrevious').onclick = () => { $('labels').replaceChildren(...(project.frames[current - 1].labels.length ? project.frames[current - 1].labels : [{}]).map(makeGroup)); changed(); };
$('completeFrame').onclick = complete;
$('editorAnnotator').oninput = () => { localStorage.setItem('framelab-annotator', $('editorAnnotator').value); changed(); };
$('onlyPending').onchange = () => guarded(async () => { if ($('onlyPending').checked && project.frames[current].reviewed) { const next = project.frames.findIndex(f => !f.reviewed); if (next >= 0) current = next; else toast('全部帧都已完成。'); } renderFrame(); });
$('exportButton').onclick = () => guarded(async () => $('exportDialog').showModal());
async function download(format) {
  const button = $(format === 'zip' ? 'exportZip' : 'exportJson'); button.disabled = true; button.textContent = '正在准备导出…';
  try {
    // Navigate through a temporary anchor so large ZIPs stream to disk rather than a JS Blob.
    const scope = $('exportScope').value;
    if (scope === '1' && !project.frames.some(f => f.reviewed)) throw Error('还没有已完成的帧，请先完成标注。');
    const a = document.createElement('a'); a.href = `/api/projects/${project.id}/export?format=${format}&reviewed=${scope}`; a.download = ''; document.body.append(a); a.click(); a.remove(); toast('已开始导出，请在浏览器下载列表查看。');
  } catch (err) { toast(err.message); } finally { button.disabled = false; button.textContent = format === 'zip' ? '↓ 图片 + JSON（ZIP）' : '仅 JSON'; }
}
$('exportJson').onclick = () => download('json'); $('exportZip').onclick = () => download('zip');
document.addEventListener('keydown', event => {
  if ($('editor').hidden || $('exportDialog').open) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); complete(); return;}
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
});
window.addEventListener('beforeunload', event => { if (revision !== savedRevision || uploading) { event.preventDefault(); event.returnValue = ''; } });
function updateFile() { const file = $('video').files[0]; if (file) { $('fileName').textContent = file.name; $('fileMeta').textContent = `${(file.size / 1024**2).toFixed(1)} MB · 视频已选择`; } }
$('video').onchange = updateFile;
for (const event of ['dragenter','dragover']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.add('dragover');});
for (const event of ['dragleave','drop']) $('dropzone').addEventListener(event, e => {e.preventDefault(); $('dropzone').classList.remove('dragover');});
$('dropzone').addEventListener('drop', e => { if (e.dataTransfer.files.length) { const transfer = new DataTransfer(); transfer.items.add(e.dataTransfer.files[0]); $('video').files = transfer.files; updateFile(); } });
function frequency() { const seconds = Number($('interval').value); $('frequencyHint').textContent = seconds > 0 ? `每 ${seconds} 秒提取 1 帧 · 约 ${Math.round(60 / seconds)} 帧 / 分钟` : '请输入有效的时间间隔'; document.querySelectorAll('[data-interval]').forEach(button => button.classList.toggle('selected', Number(button.dataset.interval) === seconds)); }
document.querySelectorAll('[data-interval]').forEach(button => button.onclick = () => { $('interval').value = button.dataset.interval; frequency(); });
$('interval').oninput = frequency;
$('annotator').value = localStorage.getItem('framelab-annotator') || '';
$('uploadForm').onsubmit = event => {
  event.preventDefault(); if (uploading) return;
  const file = $('video').files[0]; if (!file) return toast('请选择视频');
  if (file.size > 20 * 1024**3) return toast('文件超过 20 GB 上限');
  localStorage.setItem('framelab-annotator', $('annotator').value);
  const data = new FormData(); data.append('video', file); data.append('interval', $('interval').value); data.append('annotator', $('annotator').value);
  uploading = true; $('startButton').disabled = true;
  const xhr = new XMLHttpRequest(); xhr.open('POST','/api/projects');
  xhr.upload.onprogress = e => { $('startButton').textContent = e.lengthComputable ? `正在上传 ${Math.round(e.loaded / e.total * 100)}%` : '正在上传…'; };
  xhr.onload = async () => {
    uploading = false; $('startButton').disabled = false; $('startButton').textContent = '创建项目并抽帧 →';
    try { const p = JSON.parse(xhr.responseText); if (xhr.status !== 201) throw Error(p.error || '上传失败'); await openProject(p.id); } catch(err) { toast(err.message); }
  };
  xhr.onerror = () => { uploading = false; $('startButton').disabled = false; $('startButton').textContent = '创建项目并抽帧 →'; toast('连接失败，请确认本地服务正在运行。'); };
  xhr.send(data);
};
(async () => { try { await refreshProjects(); const id = localStorage.getItem('framelab-project'); if (id) await openProject(id); } catch(err) { toast(err.message); } })();
