"""Local video-to-frame annotation workbench. Run with python app.py."""
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid
import zipfile
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_file, send_from_directory
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('LABEL_DATA_DIR', ROOT / 'data'))
DATA.mkdir(parents=True, exist_ok=True)
app = Flask(__name__, static_folder='static')
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024**3
LOCK = threading.RLock()
FIELDS = ('instrument', 'action', 'target', 'intention', 'outcome')


def now():
    return datetime.now(timezone.utc).isoformat()


def project_dir(pid):
    if not re.fullmatch(r'[a-f0-9]{32}', pid):
        raise ValueError('项目编号无效')
    return DATA / pid


def read_project(pid):
    with LOCK:
        path = project_dir(pid) / 'project.json'
        if not path.exists():
            raise ValueError('找不到项目')
        return json.loads(path.read_text())


def save_project(project):
    path = project_dir(project['id']) / 'project.json'
    with LOCK:
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(project, ensure_ascii=False, indent=2))
        temp.replace(path)


def ffmpeg():
    return shutil.which('ffmpeg') or imageio_ffmpeg.get_ffmpeg_exe()


def extract(pid):
    try:
        p = read_project(pid)
        folder = project_dir(pid)
        probe = subprocess.run([ffmpeg(), '-hide_banner', '-i', str(folder / 'source.video')], capture_output=True, text=True)
        duration = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', probe.stderr)
        if not duration:
            raise ValueError('无法读取视频时长，请上传有效的视频文件（推荐 MP4 / MOV）。')
        h, m, s = map(float, duration.groups())
        seconds = h * 3600 + m * 60 + s
        if math.ceil(seconds / p['interval']) > 50000:
            raise ValueError('预计超过 50,000 帧，请增大抽帧间隔后创建新项目。')
        p.update(duration=seconds)
        save_project(p)
        frames_dir = folder / 'images'
        frames_dir.mkdir(exist_ok=True)
        log = folder / 'ffmpeg.log'
        with log.open('w') as output:
            process = subprocess.Popen([
                ffmpeg(), '-hide_banner', '-nostdin', '-y', '-i', str(folder / 'source.video'),
                '-an', '-vf', f"fps=1/{p['interval']}:start_time=0:round=up,showinfo",
                '-q:v', '2', '-progress', 'pipe:1', str(frames_dir / '%06d.jpg')
            ], stdout=subprocess.PIPE, stderr=output, text=True)
            for line in process.stdout:
                if line.startswith('frame='):
                    p['extracted'] = int(line.split('=')[1].strip())
                    save_project(p)
            code = process.wait()
        if code:
            raise ValueError('视频解码失败，请检查文件是否损坏，或转换为 MP4 后重试。')
        files = sorted(frames_dir.glob('*.jpg'))
        if not files:
            raise ValueError('未能抽取到图片，请尝试更小的时间间隔。')
        dimensions = re.search(r's:(\d+)x(\d+)', log.read_text(errors='replace'))
        p['width'], p['height'] = map(int, dimensions.groups()) if dimensions else (0, 0)
        p['frames'] = [dict(id=i + 1, file_name=f.name, timestamp=round(i * p['interval'], 6),
                            labels=[], reviewed=False) for i, f in enumerate(files)]
        p.update(status='ready', extracted=len(files))
        save_project(p)
    except Exception as exc:
        p = read_project(pid)
        p.update(status='error', error=str(exc))
        save_project(p)


@app.errorhandler(ValueError)
def bad_request(exc):
    return jsonify(error=str(exc)), 400


@app.errorhandler(413)
def too_large(exc):
    return jsonify(error='视频超过 20 GB 上传上限。'), 413


@app.before_request
def local_origin():
    # Block cross-site writes to this local service.
    if request.method in ('POST', 'PUT', 'DELETE'):
        origin = request.headers.get('Origin')
        if origin and origin != request.host_url.rstrip('/'):
            return jsonify(error='不允许跨站请求'), 403


@app.get('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.get('/api/projects')
def projects():
    items = []
    with LOCK:
        for path in DATA.glob('*/project.json'):
            p = json.loads(path.read_text())
            items.append({k: p.get(k) for k in ('id', 'name', 'status', 'created_at', 'annotator')})
    return jsonify(sorted(items, key=lambda p: p['created_at'], reverse=True))


@app.post('/api/projects')
def create():
    video = request.files.get('video')
    if not video or not video.filename:
        raise ValueError('请选择视频')
    try:
        interval = float(request.form.get('interval', 1))
    except ValueError:
        raise ValueError('抽帧间隔必须是数字')
    if not math.isfinite(interval) or not 0.04 <= interval <= 3600:
        raise ValueError('间隔应介于 0.04 秒和 3600 秒之间')
    annotator = request.form.get('annotator', '').strip()[:200]
    if not annotator:
        raise ValueError('请填写标注人')
    pid = uuid.uuid4().hex
    folder = project_dir(pid)
    folder.mkdir()
    video.save(folder / 'source.video')
    p = dict(id=pid, name=Path(video.filename).name[:240], interval=interval, annotator=annotator,
             created_at=now(), status='processing', extracted=0, frames=[])
    save_project(p)
    threading.Thread(target=extract, args=(pid,), daemon=True).start()
    return jsonify(p), 201


@app.get('/api/projects/<pid>')
def project(pid):
    return jsonify(read_project(pid))


@app.get('/api/projects/<pid>/images/<name>')
def frame_image(pid, name):
    return send_from_directory(project_dir(pid) / 'images', name)


@app.put('/api/projects/<pid>/frames/<int:fid>')
def update_frame(pid, fid):
    body = request.get_json()
    labels = body.get('labels')
    annotator = str(body.get('annotator', '')).strip()[:200]
    if not annotator:
        raise ValueError('请填写标注人')
    if not isinstance(labels, list) or len(labels) > 100:
        raise ValueError('每帧最多支持 100 组标签')
    cleaned = []
    for label in labels:
        if not isinstance(label, dict):
            raise ValueError('标签格式错误')
        entry = {k: str(label.get(k, '')).strip()[:2000] for k in ('class', *FIELDS)}
        if not entry['class']:
            raise ValueError('每组标签都需要填写 Class')
        if body.get('reviewed') and any(not entry[k] for k in FIELDS):
            raise ValueError('完成标注前，请填写全部五个语义字段')
        cleaned.append(entry)
    with LOCK:
        p = read_project(pid)
        if p['status'] != 'ready' or not 1 <= fid <= len(p['frames']):
            raise ValueError('帧不存在或项目尚未就绪')
        p['frames'][fid - 1].update(labels=cleaned, reviewed=bool(body.get('reviewed')),
                                   annotator=annotator, updated_at=now())
        p['annotator'] = annotator
        save_project(p)
        return jsonify(p['frames'][fid - 1])


def dataset(p, only_reviewed=False):
    frames = [f for f in p['frames'] if f['reviewed'] or not only_reviewed]
    classes = sorted({a['class'] for f in frames for a in f['labels']})
    categories = [dict(id=i + 1, name=name, supercategory='semantic') for i, name in enumerate(classes)]
    category_ids = {c['name']: c['id'] for c in categories}
    result = dict(info=dict(description=p['name'], version='1.0', date_created=p['created_at'],
                            source_video=p['name'], sample_interval_seconds=p['interval'],
                            annotation_type='frame_semantics', schema='COCO + XYTZO semantic attributes'),
                  licenses=[], categories=categories, images=[], annotations=[])
    for f in frames:
        result['images'].append(dict(id=f['id'], file_name='images/' + f['file_name'], width=p['width'],
                                     height=p['height'], timestamp_seconds=f['timestamp'],
                                     reviewed=f['reviewed'], annotator=f.get('annotator', ''),
                                     updated_at=f.get('updated_at')))
        for label in f['labels']:
            result['annotations'].append(dict(id=len(result['annotations']) + 1, image_id=f['id'],
                category_id=category_ids[label['class']], attributes={k: label[k] for k in FIELDS},
                annotator=f.get('annotator', ''), updated_at=f.get('updated_at')))
    return result


@app.get('/api/projects/<pid>/export')
def export(pid):
    p = read_project(pid)
    if p['status'] != 'ready':
        raise ValueError('项目尚未就绪')
    only_reviewed = request.args.get('reviewed') == '1'
    result = dataset(p, only_reviewed)
    if not result['images']:
        raise ValueError('没有可导出的帧，请先完成标注或选择导出全部帧')
    content = json.dumps(result, ensure_ascii=False, indent=2).encode()
    if request.args.get('format') == 'json':
        return send_file(io.BytesIO(content), mimetype='application/json', as_attachment=True, download_name='annotations.json')
    # Disk-backed archive avoids holding video datasets in RAM.
    import tempfile
    archive = tempfile.TemporaryFile()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
        z.writestr('annotations.json', content)
        z.writestr('README.txt', 'Frame annotation dataset\nCOCO-compatible image/category tables + semantic annotations.\nEach annotation is frame-level: no bounding boxes or segmentation are provided.\nX=instrument; Y=action; T=target; Z=intention; O=outcome.\nTimestamps are sampling-grid times in seconds.\nUnreviewed frames are drafts; reviewed frames with no annotations are explicitly empty.\n')
        for item in result['images']:
            z.write(project_dir(pid) / item['file_name'], item['file_name'])
    archive.seek(0)
    response = send_file(archive, mimetype='application/zip', as_attachment=True, download_name=f"dataset-{pid[:8]}.zip")
    response.call_on_close(archive.close)
    return response


if __name__ == '__main__':
    # A killed extraction cannot resume; keep an actionable error on restart.
    for path in DATA.glob('*/project.json'):
        p = json.loads(path.read_text())
        if p['status'] == 'processing':
            p.update(status='error', error='抽帧时服务中断，请重新上传视频创建项目。')
            save_project(p)
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5055)), threaded=True)
