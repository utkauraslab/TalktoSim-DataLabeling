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
EVENT_FIELDS = {
    'X': ('instrument',), 'Y': ('action', 'direction'),
    'T': ('anatomy', 'region'),
    'Z': ('intended_goal', 'goal_type', 'source'),
    'O': ('observed_effect', 'goal_achieved', 'source'),
}


def event_label(label):
    """Expose old flat labels without discarding any existing annotations."""
    if isinstance(label.get('X'), dict):
        return label
    return dict(event_id=label.get('event_id', ''), **{'class': label.get('class', '')},
                time=dict(start=None, end=None, outcome_observed_at=None),
                X=dict(instrument=label.get('instrument', '')),
                Y=dict(action=label.get('action', ''), direction=''),
                T=dict(anatomy=label.get('target', ''), region=''),
                Z=dict(intended_goal=label.get('intention', ''), goal_type='', source=''),
                O=dict(observed_effect=label.get('outcome', ''), goal_achieved='',
                       evidence_interval=[None, None], source=''))


def clean_event(label, reviewed, duration):
    if not isinstance(label, dict):
        raise ValueError('Each annotation must be an object.')
    legacy = not any(k in label for k in ('X', 'Y', 'T', 'Z', 'O', 'time'))
    original = label
    label = event_label(label) if legacy else label
    entry = {k: str(label.get(k) or '').strip()[:2000] for k in ('class', 'event_id')}
    if not entry['class']:
        raise ValueError('Every annotation needs a Class.')
    for group, keys in EVENT_FIELDS.items():
        values = label.get(group, {})
        if not isinstance(values, dict):
            raise ValueError(f'{group} must be an object.')
        entry[group] = {key: str(values.get(key) or '').strip()[:2000] for key in keys}
        reserved = set(keys) | ({'evidence_interval'} if group == 'O' else set())
        extras = [(key, value) for key, value in values.items() if key not in reserved]
        if len(extras) > 50:
            raise ValueError(f'{group} supports up to 50 custom fields.')
        for key, value in extras:
            name = key.strip()
            if not name or len(name) > 80 or name in reserved or name in ('__proto__', 'constructor', 'prototype'):
                raise ValueError(f'{group}: choose a unique custom field name (1–80 characters).')
            if name in entry[group]:
                raise ValueError(f'{group}: duplicate custom field name: {name}.')
            if not isinstance(value, str) or len(value) > 2000:
                raise ValueError(f'{group}.{name} must be text, up to 2,000 characters.')
            entry[group][name] = value.strip()
            if reviewed and not entry[group][name]:
                raise ValueError(f'Fill in {group}.{name} or remove it before marking reviewed.')

    def seconds(value):
        if value is None or value == '':
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError('Times must be numeric seconds.')
        value = float(value)
        if not math.isfinite(value) or value < 0 or value > duration + 0.001:
            raise ValueError(f'Times must be between 0 and the video duration ({duration:g} s).')
        return value

    timing = label.get('time', {})
    if not isinstance(timing, dict):
        raise ValueError('time must be an object.')
    entry['time'] = {k: seconds(timing.get(k)) for k in ('start', 'end', 'outcome_observed_at')}
    interval = label.get('O', {}).get('evidence_interval', [None, None])
    if not isinstance(interval, list) or len(interval) != 2:
        raise ValueError('Evidence interval must contain [start, end].')
    entry['O']['evidence_interval'] = [seconds(v) for v in interval]
    t = entry['time']
    if t['start'] is not None and t['end'] is not None and t['start'] > t['end']:
        raise ValueError('Event start must be at or before event end.')
    if t['end'] is not None and t['outcome_observed_at'] is not None and t['end'] > t['outcome_observed_at']:
        raise ValueError('Outcome observation time must be at or after event end.')
    a, b = entry['O']['evidence_interval']
    if a is not None and b is not None and a > b:
        raise ValueError('Evidence start must be at or before evidence end.')
    if reviewed:
        if legacy:
            if any(not original.get(k) for k in FIELDS):
                raise ValueError('Complete all five semantic fields before marking reviewed.')
        elif (not entry['event_id'] or any(v is None for v in t.values())
              or any(not entry[g][k] for g, keys in EVENT_FIELDS.items() for k in keys)
              or any(v is None for v in entry['O']['evidence_interval'])):
            raise ValueError('Complete Event ID, all time fields, and all X/Y/T/Z/O fields before marking reviewed.')
    return entry


def now():
    return datetime.now(timezone.utc).isoformat()


def project_dir(pid):
    if not re.fullmatch(r'[a-f0-9]{32}', pid):
        raise ValueError('Invalid project ID.')
    return DATA / pid


def read_project(pid):
    with LOCK:
        path = project_dir(pid) / 'project.json'
        if not path.exists():
            raise ValueError('Project not found.')
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
            raise ValueError('Could not read the video duration. Upload a valid video (MP4 / MOV recommended).')
        h, m, s = map(float, duration.groups())
        seconds = h * 3600 + m * 60 + s
        if math.ceil(seconds / p['interval']) > 50000:
            raise ValueError('More than 50,000 frames expected. Increase the sampling interval and create a new project.')
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
            raise ValueError('Video decoding failed. Check the file or convert it to MP4 and try again.')
        files = sorted(frames_dir.glob('*.jpg'))
        if not files:
            raise ValueError('No frames extracted. Try a shorter sampling interval.')
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
    return jsonify(error='The video exceeds the 20 GB upload limit.'), 413


@app.before_request
def local_origin():
    # Block cross-site writes to this local service.
    if request.method in ('POST', 'PUT', 'DELETE'):
        origin = request.headers.get('Origin')
        if origin and origin != request.host_url.rstrip('/'):
            return jsonify(error='Cross-origin requests are not allowed.'), 403


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
        raise ValueError('Choose a video.')
    try:
        interval = float(request.form.get('interval', 1))
    except ValueError:
        raise ValueError('Sampling interval must be a number.')
    if not math.isfinite(interval) or not 0.04 <= interval <= 3600:
        raise ValueError('Sampling interval must be between 0.04 and 3600 seconds.')
    annotator = request.form.get('annotator', '').strip()[:200]
    if not annotator:
        raise ValueError('Enter an annotator name or ID.')
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
    if not isinstance(body, dict):
        raise ValueError('Request body must be an object.')
    labels = body.get('labels')
    annotator = str(body.get('annotator', '')).strip()[:200]
    if not annotator:
        raise ValueError('Enter an annotator name or ID.')
    if not isinstance(labels, list) or len(labels) > 100:
        raise ValueError('Each frame supports up to 100 event annotations.')
    with LOCK:
        p = read_project(pid)
        if p['status'] != 'ready' or not 1 <= fid <= len(p['frames']):
            raise ValueError('Frame not found or project is not ready.')
        cleaned = [clean_event(label, bool(body.get('reviewed')), p['duration']) for label in labels]
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
    result = dict(info=dict(description=p['name'], version='2.0', date_created=p['created_at'],
                            source_video=p['name'], sample_interval_seconds=p['interval'],
                            annotation_type='frame_semantics', schema='COCO + XYTZO semantic attributes'),
                  licenses=[], categories=categories, images=[], annotations=[], events=[])
    for f in frames:
        result['images'].append(dict(id=f['id'], file_name='images/' + f['file_name'], width=p['width'],
                                     height=p['height'], timestamp_seconds=f['timestamp'],
                                     reviewed=f['reviewed'], annotator=f.get('annotator', ''),
                                     updated_at=f.get('updated_at')))
        for label in f['labels']:
            event = event_label(label)
            attributes = dict(instrument=event['X']['instrument'], action=event['Y']['action'],
                              target=event['T']['anatomy'], intention=event['Z']['intended_goal'],
                              outcome=event['O']['observed_effect'])
            result['annotations'].append(dict(id=len(result['annotations']) + 1, image_id=f['id'],
                category_id=category_ids[label['class']], attributes=attributes, **event,
                annotator=f.get('annotator', ''), updated_at=f.get('updated_at')))
            result['events'].append(dict(**event, image_id=f['id'],
                annotator=f.get('annotator', ''), updated_at=f.get('updated_at'), reviewed=f['reviewed']))
    return result


@app.get('/api/projects/<pid>/export')
def export(pid):
    p = read_project(pid)
    if p['status'] != 'ready':
        raise ValueError('The project is not ready.')
    only_reviewed = request.args.get('reviewed') == '1'
    result = dataset(p, only_reviewed)
    if not result['images']:
        raise ValueError('No frames to export. Review a frame first or export all frames.')
    content = json.dumps(result, ensure_ascii=False, indent=2).encode()
    if request.args.get('format') == 'events':
        return send_file(io.BytesIO(json.dumps(result['events'], ensure_ascii=False, indent=2).encode()),
                         mimetype='application/json', as_attachment=True, download_name='events.json')
    if request.args.get('format') == 'json':
        return send_file(io.BytesIO(content), mimetype='application/json', as_attachment=True, download_name='annotations.json')
    # Disk-backed archive avoids holding video datasets in RAM.
    import tempfile
    archive = tempfile.TemporaryFile()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED, allowZip64=True) as z:
        z.writestr('annotations.json', content)
        z.writestr('events.json', json.dumps(result['events'], ensure_ascii=False, indent=2))
        z.writestr('README.txt', 'Frame annotation dataset\nCOCO-compatible image/category tables + semantic annotations.\nEach annotation is frame-level: no bounding boxes or segmentation are provided.\nevents.json contains nested event_id/time/X/Y/T/Z/O records, class and per-frame metadata.\nX=instrument; Y=action/direction; T=anatomy/region; Z=intention; O=outcome/evidence.\nEvent and evidence times are source-video seconds; image timestamps are sampling-grid times.\nTimestamps are sampling-grid times in seconds.\nUnreviewed frames are drafts; reviewed frames with no annotations are explicitly empty.\n')
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
            p.update(status='error', error='The server stopped during extraction. Upload the video again to create a new project.')
            save_project(p)
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5055)), threaded=True)
