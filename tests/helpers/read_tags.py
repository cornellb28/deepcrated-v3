#!/usr/bin/env python3
"""
Test-only tag reader. Deliberately NOT sidecar/analyze.py: analyze.py
normalises and renames fields on its way out (and can fall through to
librosa), which would let a spec pass against a value analyze.py invented
rather than the bytes edit_tags.py actually wrote. This reads the raw
frames/atoms straight back so a round-trip assertion is a real one.

    read_tags.py <filepath>  ->  one JSON object on stdout
"""
import sys
import json
import os

from mutagen.id3 import ID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen.aiff import AIFF
from mutagen.wave import WAVE

MP4_CRATECLOUD_KEY = '----:com.apple.iTunes:CRATECLOUD_ID'


def _id3(tags):
    def text(key):
        frame = tags.get(key)
        if frame is None:
            return None
        values = getattr(frame, 'text', None)
        return str(values[0]) if values else None

    return {
        'title': text('TIT2'),
        'artist': text('TPE1'),
        'album': text('TALB'),
        'genre': text('TCON'),
        'year': text('TDRC'),
        'bpm': text('TBPM'),
        'key': text('TKEY'),
        'remixer': text('TPE4'),
        'label': text('TPUB'),
        'grouping': text('TIT1'),
        'composer': text('TCOM'),
        'comment': text('COMM::eng'),
        'cratecloud_id': text('TXXX:CRATECLOUD_ID'),
        # Serato's own payloads are GEOB frames keyed by description —
        # "Serato Autotags" is the one edit_tags.py claims to write.
        'geob': sorted(k for k in tags.keys() if k.startswith('GEOB')),
    }


def _first(mapping, key):
    value = mapping.get(key)
    if not value:
        return None
    return str(value[0])


def read(filepath):
    ext = os.path.splitext(filepath)[1].lower()

    if ext == '.mp3':
        return _id3(ID3(filepath))
    if ext in ('.aiff', '.aif'):
        return _id3(AIFF(filepath).tags)
    if ext == '.wav':
        return _id3(WAVE(filepath).tags)
    if ext == '.flac':
        audio = FLAC(filepath)
        return {
            'title': _first(audio, 'title'),
            'artist': _first(audio, 'artist'),
            'album': _first(audio, 'album'),
            'genre': _first(audio, 'genre'),
            'year': _first(audio, 'date'),
            'bpm': _first(audio, 'bpm'),
            'key': _first(audio, 'key'),
            'remixer': _first(audio, 'remixer'),
            'label': _first(audio, 'organization'),
            'grouping': _first(audio, 'grouping'),
            'composer': _first(audio, 'composer'),
            'comment': _first(audio, 'comment'),
            'cratecloud_id': _first(audio, 'cratecloud_id'),
            'geob': [],
        }
    if ext == '.m4a':
        tags = MP4(filepath).tags or {}
        raw_id = tags.get(MP4_CRATECLOUD_KEY)
        cratecloud_id = None
        if raw_id:
            value = raw_id[0]
            cratecloud_id = value.decode('utf-8', 'ignore') if isinstance(value, bytes) else str(value)
        bpm = tags.get('tmpo')

        def freeform(name):
            value = tags.get(f'----:com.apple.iTunes:{name}')
            if not value:
                return None
            raw = value[0]
            return raw.decode('utf-8', 'ignore') if isinstance(raw, bytes) else str(raw)

        return {
            'title': _first(tags, '\xa9nam'),
            'artist': _first(tags, '\xa9ART'),
            'album': _first(tags, '\xa9alb'),
            'genre': _first(tags, '\xa9gen'),
            'year': _first(tags, '\xa9day'),
            'bpm': str(bpm[0]) if bpm else None,
            'key': freeform('initialkey'),
            'remixer': freeform('REMIXER'),
            # LABEL is what edit_tags.py writes; PUBLISHER is accepted as a
            # fallback because files tagged elsewhere carry the label there.
            'label': freeform('LABEL') or freeform('PUBLISHER'),
            'grouping': _first(tags, '\xa9grp'),
            'composer': _first(tags, '\xa9wrt'),
            'comment': _first(tags, '\xa9cmt'),
            'cratecloud_id': cratecloud_id,
            'geob': [],
        }

    raise ValueError(f'unsupported extension: {ext}')


if __name__ == '__main__':
    path = sys.argv[1]
    try:
        print(json.dumps({'ok': True, 'tags': read(path)}))
    except Exception as exc:  # noqa: BLE001 - surfaced to the test as a failure
        print(json.dumps({'ok': False, 'error': str(exc)}))
