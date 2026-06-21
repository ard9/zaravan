#!/usr/bin/env bash
# ============================================================
#  MyTube — start script (macOS / Linux)
# ============================================================
cd "$(dirname "$0")"

echo "Checking Python dependencies..."
python3 -m pip install -r backend/requirements.txt --quiet

echo
echo "Starting MyTube server..."
echo "Open http://127.0.0.1:8420 in your browser"
echo "Press Ctrl+C to stop."
echo

python3 backend/main.py
