#!/bin/zsh
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import flask, imageio_ffmpeg' 2>/dev/null; then
  .venv/bin/pip install -r requirements.txt
fi
echo 'FrameLab: http://127.0.0.1:5055'
(sleep 2; open http://127.0.0.1:5055) &
exec .venv/bin/python app.py
