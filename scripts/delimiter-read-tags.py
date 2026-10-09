#!/usr/bin/env python3
"""
Read-only raw artist reader for scripts/delimiter-dry-run.mjs (and the gated
write-back). Uses the same mutagen the sidecar uses. Reads the RAW frame/atom,
never normalises, never writes.

    delimiter-read-tags.py < paths.json   (JSON array of file paths)
    -> JSON array on stdout, one entry per path:
       { path, ok, kind, values: [str], error }
       kind is the container's artist field: TPE1 | ARTIST | ©ART
       values has >1 entry only for a TRUE multi-value tag.
"""
import sys
import json
import os

from mutagen.id3 import ID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen.aiff import AIFF
from mutagen.wave import WAVE


def read_one(path):
    ext = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        return {'ok': False, 'error': 'file not found'}
    try:
        if ext == '.mp3':
            try:
                tags = ID3(path)
            except Exception as e:  # no ID3 header at all
                if type(e).__name__ == 'ID3NoHeaderError':
                    return {'ok': True, 'kind': 'TPE1', 'values': []}
                raise
            frame = tags.get('TPE1')
            return {'ok': True, 'kind': 'TPE1',
                    'values': [str(v) for v in frame.text] if frame else []}
        if ext in ('.aif', '.aiff', '.wav'):
            audio = AIFF(path) if ext != '.wav' else WAVE(path)
            tags = audio.tags
            frame = tags.get('TPE1') if tags else None
            return {'ok': True, 'kind': 'TPE1',
                    'values': [str(v) for v in frame.text] if frame else []}
        if ext == '.flac':
            audio = FLAC(path)
            return {'ok': True, 'kind': 'ARTIST',
                    'values': [str(v) for v in (audio.get('artist') or [])]}
        if ext in ('.m4a', '.mp4', '.m4b'):
            audio = MP4(path)
            return {'ok': True, 'kind': '©ART',
                    'values': [str(v) for v in ((audio.tags or {}).get('©ART') or [])]}
        return {'ok': False, 'error': 'unsupported format %s' % ext}
    except Exception as e:
        return {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}


def main():
    paths = json.load(sys.stdin)
    out = []
    for p in paths:
        r = read_one(p)
        r['path'] = p
        out.append(r)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
