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
        assert set(z.namelist()) == {'annotations.json', 'README.txt', 'images/000001.jpg', 'images/000002.jpg'}
        assert json.loads(z.read('annotations.json')) == result
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
