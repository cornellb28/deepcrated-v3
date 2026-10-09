#!/usr/bin/env python3
"""
Phase 2 of the delimiter cleanup. Called by scripts/delimiter-writeback.mjs,
which has already re-run the dry run and passes ONLY delimiter_only rows.

    delimiter-writeback.py <plan.json> <backup-dir> <backup-json>

plan.json: [{id, path, expected_current, proposed}]

Per file, in order:
  1. skip if the file's artist no longer equals expected_current (it changed
     since the dry run — never overwrite something we did not classify)
  2. back up: copy the original file, and record its full tag dump
  3. write ONLY the artist frame (TPE1 / ©ART), keeping the tag version,
     encoding, every other frame and the audio stream untouched
  4. read it back and require artist == proposed AND every other tag equal to
     its pre-write dump AND audio length unchanged
Never touches the database. A failure is reported, never swallowed.
"""
import sys
import os
import json
import shutil
import hashlib

from mutagen.id3 import ID3, TPE1
from mutagen.mp4 import MP4
from mutagen.aiff import AIFF
from mutagen.wave import WAVE

ID3_EXTS = ('.mp3',)
CHUNK_EXTS = ('.wav', '.aif', '.aiff')
MP4_EXTS = ('.m4a', '.mp4', '.m4b')
MP4_ARTIST = '©ART'


def open_tags(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ID3_EXTS:
        t = ID3(path)
        return ext, t, t
    if ext in CHUNK_EXTS:
        audio = AIFF(path) if ext != '.wav' else WAVE(path)
        return ext, audio, audio.tags
    if ext in MP4_EXTS:
        audio = MP4(path)
        return ext, audio, audio.tags
    raise ValueError('unsupported format %s' % ext)


def artist_of(ext, tags):
    if tags is None:
        return []
    if ext in MP4_EXTS:
        return [str(v) for v in (tags.get(MP4_ARTIST) or [])]
    frame = tags.get('TPE1')
    return [str(v) for v in frame.text] if frame else []


def dump_other(ext, tags):
    """Everything except the artist field, as comparable strings."""
    if tags is None:
        return {}
    skip = MP4_ARTIST if ext in MP4_EXTS else 'TPE1'
    return {k: repr(v) for k, v in tags.items() if k != skip}


def audio_length(path):
    from mutagen import File
    f = File(path)
    return round(f.info.length, 3) if f is not None and f.info is not None else None


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def write_artist(path, new):
    ext, container, tags = open_tags(path)
    if ext in MP4_EXTS:
        tags[MP4_ARTIST] = [new]
        container.save()
        return
    if tags is None:
        raise ValueError('no ID3 tag to update')
    old = tags.get('TPE1')
    enc = old.encoding if old is not None else 3
    tags['TPE1'] = TPE1(encoding=enc, text=[new])
    version = tags.version[1]  # keep v2.3 as v2.3, v2.4 as v2.4
    if ext in ID3_EXTS:
        tags.save(path, v2_version=version)
    else:
        container.save(v2_version=version)


def main():
    plan_path, backup_dir, backup_json = sys.argv[1:4]
    with open(plan_path) as fh:
        plan = json.load(fh)
    os.makedirs(backup_dir, exist_ok=True)

    backup = []
    results = []
    for item in plan:
        path, pid = item['path'], item['id']
        res = {'id': pid, 'path': path, 'status': None, 'detail': ''}
        results.append(res)
        try:
            ext, _, tags = open_tags(path)
            current = artist_of(ext, tags)
            if len(current) != 1 or current[0] != item['expected_current']:
                res['status'] = 'skipped'
                res['detail'] = 'file changed since dry run: %r' % (current,)
                continue
            if not os.access(path, os.W_OK):
                res['status'] = 'failed'
                res['detail'] = 'file is not writable'
                continue

            # 2. back up
            dest = os.path.join(backup_dir, '%s-%s' % (pid, os.path.basename(path)))
            shutil.copy2(path, dest)
            before_other = dump_other(ext, tags)
            before_len = audio_length(path)
            backup.append({
                'id': pid, 'path': path, 'backup_copy': dest,
                'size': os.path.getsize(path), 'sha256': sha256(path),
                'artist_values': current, 'audio_length': before_len,
                'tags': before_other,
            })

            # 3. write only the artist
            write_artist(path, item['proposed'])

            # 4. verify
            ext2, _, tags2 = open_tags(path)
            got = artist_of(ext2, tags2)
            problems = []
            if got != [item['proposed']]:
                problems.append('artist reads %r, wanted %r' % (got, item['proposed']))
            after_other = dump_other(ext2, tags2)
            if after_other != before_other:
                changed = sorted(set(before_other) ^ set(after_other) |
                                 {k for k in before_other if k in after_other and before_other[k] != after_other[k]})
                problems.append('other tags changed: %s' % ', '.join(changed))
            if audio_length(path) != before_len:
                problems.append('audio length changed')
            if problems:
                res['status'] = 'failed'
                res['detail'] = '; '.join(problems) + ' (original kept at %s)' % dest
            else:
                res['status'] = 'verified'
                res['detail'] = '%r -> %r' % (current[0], got[0])
        except Exception as e:
            res['status'] = 'failed'
            res['detail'] = '%s: %s' % (type(e).__name__, e)

    with open(backup_json, 'w') as fh:
        json.dump(backup, fh, ensure_ascii=False, indent=2)
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
