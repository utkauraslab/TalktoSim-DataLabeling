import io
import json
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as module


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(module, 'DATA', tmp_path / 'data')
    module.DATA.mkdir()
    module.app.config['TESTING'] = True
    return module.app.test_client()


@pytest.mark.parametrize('interval', [0.5, 1])
def test_full_workflow(client, tmp_path, interval):
    video = tmp_path / 'sample.mp4'
    subprocess.run([module.ffmpeg(), '-v', 'error', '-f', 'lavfi', '-i',
                    'testsrc=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', str(video)], check=True)
    response = client.post('/api/projects', data=dict(video=(io.BytesIO(video.read_bytes()), '测试视频.mp4'), interval=str(interval), annotator='Alice'))
    assert response.status_code == 201
    pid = response.json['id']
    for _ in range(200):
        p = client.get(f'/api/projects/{pid}').json
        if p['status'] != 'processing':
            break
        time.sleep(.05)
    assert p['status'] == 'ready', p
    assert len(p['frames']) == int(2 / interval)
    assert [f['timestamp'] for f in p['frames']] == [i * interval for i in range(int(2 / interval))]
    assert (p['width'], p['height']) == (320, 240)
    assert client.get(f'/api/projects/{pid}/images/000001.jpg').status_code == 200
    label = dict(zip(('class', *module.FIELDS), ('操作', '钳子', '抓取', '组织', '稳定组织', '组织已固定')))
    invalid = client.put(f'/api/projects/{pid}/frames/1', json=dict(labels=[{'class':'x'}], reviewed=True, annotator='Alice'))
    assert invalid.status_code == 400
    saved = client.put(f'/api/projects/{pid}/frames/1', json=dict(labels=[label, {**label, 'class':'第二类'}], reviewed=True, annotator='Alice'))
    assert saved.status_code == 200
    # Explicit empty frame (negative example).
    assert client.put(f'/api/projects/{pid}/frames/2', json=dict(labels=[], reviewed=True, annotator='Bob')).status_code == 200
    result = client.get(f'/api/projects/{pid}/export?format=json&reviewed=1').json
    assert len(result['images']) == 2
    assert len(result['annotations']) == 2
    assert len(result['categories']) == 2
    assert result['annotations'][0]['attributes']['instrument'] == '钳子'
    assert result['annotations'][0]['annotator'] == 'Alice'
    assert result['images'][1]['annotator'] == 'Bob'
    archive = client.get(f'/api/projects/{pid}/export?reviewed=1')
    with zipfile.ZipFile(io.BytesIO(archive.data)) as z:
        assert set(z.namelist()) == {'annotations.json', 'events.json', 'README.txt', 'images/000001.jpg', 'images/000002.jpg'}
        assert json.loads(z.read('annotations.json')) == result
        assert json.loads(z.read('events.json')) == result['events']
    # Reopen from persistent storage.
    assert module.read_project(pid)['frames'][0]['reviewed']
    assert len(client.get('/api/projects').json) == 1


@pytest.mark.parametrize('interval', ['0', '-1', 'nan', 'inf', 'bad', '0.001'])
def test_bad_interval(client, interval):
    response = client.post('/api/projects', data=dict(video=(io.BytesIO(b'x'), 'a.mp4'), interval=interval, annotator='A'))
    assert response.status_code == 400


def test_cross_site_write(client):
    assert client.post('/api/projects', headers={'Origin':'https://example.com'}).status_code == 403


def test_bad_video(client):
    response = client.post('/api/projects', data=dict(video=(io.BytesIO(b'not video'), 'broken.mp4'), interval='1', annotator='A'))
    pid = response.json['id']
    for _ in range(200):
        p = client.get(f'/api/projects/{pid}').json
        if p['status'] != 'processing':
            break
        time.sleep(.05)
    assert p['status'] == 'error'
    assert client.get(f'/api/projects/{pid}/export').status_code == 400


@pytest.fixture
def event_project(client):
    pid = 'a' * 32
    module.project_dir(pid).mkdir()
    module.save_project(dict(id=pid, name='source.mp4', interval=1, duration=60, width=320,
        height=240, status='ready', created_at=module.now(), annotator='Alice',
        frames=[dict(id=1, file_name='000001.jpg', timestamp=42, labels=[], reviewed=False)]))
    return pid


def reference():
    return {**json.loads((module.ROOT / 'static/example.json').read_text()), 'class':'anatomical_exposure'}


def test_nested_example_round_trip(client, event_project):
    pid = event_project
    record = reference()
    saved = client.put(f'/api/projects/{pid}/frames/1', json=dict(labels=[record], reviewed=True, annotator='Expert A'))
    assert saved.status_code == 200
    assert saved.json['labels'] == [record]
    reopened = client.get(f'/api/projects/{pid}').json
    assert reopened['frames'][0]['labels'] == [record]
    exported = client.get(f'/api/projects/{pid}/export?format=events&reviewed=1').json
    assert len(exported) == 1
    assert {k:exported[0][k] for k in record} == record
    assert exported[0]['annotator'] == 'Expert A'
    assert exported[0]['image_id'] == 1
    assert exported[0]['O']['evidence_interval'] == [49.5, 52.0]
    dataset = client.get(f'/api/projects/{pid}/export?format=json').json
    assert dataset['events'] == exported
    assert dataset['annotations'][0]['time'] == record['time']
    assert dataset['annotations'][0]['Z'] == record['Z']


@pytest.mark.parametrize('change', ['negative', 'reverse', 'late', 'missing', 'evidence_reverse', 'bad_type', 'nan'])
def test_invalid_event_times(client, event_project, change):
    record = reference()
    if change == 'negative': record['time']['start'] = -1
    if change == 'reverse': record['time']['start'] = 50
    if change == 'late': record['time']['outcome_observed_at'] = 61
    if change == 'missing': record['time']['end'] = None
    if change == 'evidence_reverse': record['O']['evidence_interval'] = [52, 49]
    if change == 'bad_type': record['time']['end'] = '49.5'
    if change == 'nan': record['time']['end'] = float('nan')
    response = client.put(f'/api/projects/{event_project}/frames/1', json=dict(labels=[record], reviewed=True, annotator='A'))
    assert response.status_code == 400
    assert module.read_project(event_project)['frames'][0]['labels'] == []


def test_partial_event_and_zero_time(client, event_project):
    record = {'class':'draft', 'event_id':'e1', 'time':{'start':0}, 'X':{'instrument':'grasper'}}
    response = client.put(f'/api/projects/{event_project}/frames/1', json=dict(labels=[record], reviewed=False, annotator='A'))
    assert response.status_code == 200
    assert response.json['labels'][0]['time']['start'] == 0
    assert response.json['labels'][0]['time']['end'] is None
    assert response.json['labels'][0]['O']['evidence_interval'] == [None, None]
    assert client.get(f'/api/projects/{event_project}/export?format=events&reviewed=1').status_code == 400


def test_legacy_export_preserves_labels(client, event_project):
    p = module.read_project(event_project)
    p['frames'][0]['labels'] = [dict(zip(('class', *module.FIELDS), ('c', 'grasper', 'retract', 'fundus', 'exposure', 'visible')))]
    module.save_project(p)
    result = client.get(f'/api/projects/{event_project}/export?format=events').json[0]
    assert result['X']['instrument'] == 'grasper'
    assert result['T']['anatomy'] == 'fundus'
    assert result['time']['start'] is None
    assert result['Z']['source'] == ''


def test_english_interface_and_example(client):
    html = client.get('/').get_data(as_text=True)
    assert '<html lang="en">' in html
    assert 'View annotation example' in html
    assert client.get('/static/example.json').json == {k:v for k,v in reference().items() if k != 'class'}
