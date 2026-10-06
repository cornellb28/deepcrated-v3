#!/usr/bin/env bash
# Builds the two production sidecar executables (analyze, edit_tags) via
# PyInstaller. Must run natively on each target OS — PyInstaller does not
# cross-compile. Run this before `npm run build:<platform>` on every
# platform; electron-builder's extraResources picks up sidecar/dist/*.
#
# Requires sidecar/.venv to already exist with requirements.txt installed,
# plus pyinstaller itself, which requirements.txt deliberately does not pin
# (it is a build tool, not a runtime dependency) — this script does not
# create the venv itself.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "sidecar/.venv not found — run 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' first." >&2
  exit 1
fi

# Windows venvs use Scripts/, not bin/ — support both without needing a
# separate script for CI's windows-latest runner.
if [ -x .venv/bin/pyinstaller ]; then
  PYINSTALLER=.venv/bin/pyinstaller
elif [ -x .venv/Scripts/pyinstaller.exe ]; then
  PYINSTALLER=.venv/Scripts/pyinstaller.exe
else
  echo "Could not find pyinstaller in sidecar/.venv (checked bin/ and Scripts/)." >&2
  exit 1
fi

rm -rf dist build

"$PYINSTALLER" --onefile --name analyze \
  --collect-all librosa --collect-all numba --collect-all soundfile --collect-all sklearn \
  --distpath dist --workpath build --specpath . \
  analyze.py

# serato_tools must be collected explicitly: edit_tags.py imports it inside
# a try/except that degrades to HAS_SERATO = False, so a build that misses it
# still runs and still reports success — it just silently stops writing the
# Serato Autotags block, which is the whole reason Serato ever sees a BPM.
"$PYINSTALLER" --onefile --name edit_tags \
  --collect-all mutagen --collect-all serato_tools \
  --distpath dist --workpath build --specpath . \
  edit_tags.py

echo "Built sidecar/dist/analyze and sidecar/dist/edit_tags"
