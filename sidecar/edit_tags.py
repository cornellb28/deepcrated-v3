#!/usr/bin/env python3
"""
Edit standard and Serato metadata on an audio file.
Writes:
  - Standard tags (ID3/FLAC/MP4) via mutagen
  - Serato Autotags (BPM) via serato-tools for MP3/FLAC
  - An opt-in CRATECLOUD_ID tag, read back by analyze.py/reconcile as a
    track's stable identity across moves and renames

Single-file mode (backwards compatible with v2):
    edit_tags.py <filepath> --meta '{"title": "..."}' [--no-serato]

Batch mode — reads newline-delimited JSON {"filepath": ..., "meta": {...}}
objects from stdin, writes one JSON result line to stdout per input, in
the same order, flushed immediately so a caller can stream progress:
    edit_tags.py --batch [--no-serato] < items.ndjson
"""
# TODO(cratecloud): not yet packaged — port v2 sidecar/build.sh
# (PyInstaller targets for analyze + edit_tags) as a separate task.

import os
import sys
import json
import shutil
import tempfile
import argparse

from mutagen.id3 import (
    ID3, TIT2, TPE1, TALB, TCON, TBPM, TKEY, TDRC, TPE4, TIT1, TCOM, COMM,
    TPUB, TXXX, error as ID3Error
)
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4, MP4FreeForm
from mutagen.aiff import AIFF
from mutagen.wave import WAVE

# TODO(cratecloud): add serato-tools to sidecar requirements + PyInstaller
# hidden imports before release. Dependency change — separate confirmed step.
try:
    from serato_tools.track_autotags import TrackAutotags
    HAS_SERATO = True
except ImportError:
    HAS_SERATO = False

# Formats this script can write standard tags for. OGG is an audio format
# analyze.py can read, but is treated as unsupported for writing here rather
# than silently no-op succeeding (v2's edit_file fell through to
# `success: True` for them with nothing actually written).
SUPPORTED = {'.mp3', '.flac', '.aiff', '.aif', '.m4a', '.wav'}

# TODO(cratecloud): OGG tag writing unsupported — mutagen.oggvorbis.OggVorbis
# exists (plain Vorbis comments, same shape as FLAC's) but was never wired
# up here. Add edit_ogg() in a follow-up if the UI needs to edit OGG metadata.

MP4_CRATECLOUD_KEY = '----:com.apple.iTunes:CRATECLOUD_ID'

# MP4 has no standard atom for key, label or remixer, so these three travel as
# iTunes freeform atoms. The names are not arbitrary:
#
#   initialkey — verified against this project's reference library: of 848 .m4a
#     files present in Serato's `database V2`, 815 carry this atom and Serato's
#     cached `tkey` equals it in every one. Where a file has both `initialkey`
#     and `KEY` (20 files) Serato shows `initialkey`, so that is the one to
#     write. Key IS therefore visible in Serato for M4A.
#   LABEL / REMIXER — the MusicBrainz Picard mapping, so other taggers read
#     them back. Serato does NOT read either one from an MP4: the same library
#     has four .m4a files carrying a PUBLISHER atom whose Serato entries are
#     fresh (cached mtime == file mtime, i.e. Serato has read their tags) and
#     whose `tlbl` is still empty, and across all 232 labelled .m4a entries not
#     one label originates from a file tag. Serato keeps a label for an MP4 in
#     its own database only. These are written so the value survives in the
#     file and round-trips through analyze.py and other tools — not because
#     Serato will display them.
MP4_KEY_KEY = '----:com.apple.iTunes:initialkey'
MP4_LABEL_KEY = '----:com.apple.iTunes:LABEL'
MP4_REMIXER_KEY = '----:com.apple.iTunes:REMIXER'


def _try_serato_autotags(target, meta, write_serato, supported):
    """
    Attempt to write Serato Autotags (BPM) into target, which is either a
    filepath (serato-tools dispatches MP3/AIFF itself by extension) or an
    already-open ID3-compatible tags object (needed for WAV, whose ".wav"
    extension serato-tools' own dispatch doesn't recognize — TrackAutotags
    accepts a tags object directly instead, bypassing that dispatch).

    Always returns (wrote: bool, error: str | None) — error is populated
    any time wrote is False, so a caller never has to guess why
    serato_written came back false (v2 swallowed this with a bare
    `except: pass`).
    """
    if not supported:
        return False, 'Serato autotags not supported for this format'
    if not write_serato:
        return False, 'Serato write skipped (--no-serato)'
    if not HAS_SERATO:
        return False, 'serato-tools not installed'
    if meta.get('bpm') is None:
        return False, 'No bpm provided — Serato autotags require a bpm value'
    try:
        at = TrackAutotags(target)
        # A track with no prior Serato Autotags block (never analyzed by
        # Serato, or never touched by this tool before) parses autogain/
        # gaindb as None. TrackAutotags.set()'s dump formats all three
        # fields unconditionally, so a bpm-only set() crashes on first
        # write unless the other two are seeded with a neutral default.
        if at.autogain is None:
            at.autogain = 0.0
        if at.gaindb is None:
            at.gaindb = 0.0
        at.set(bpm=float(meta['bpm']))
        at.save()
        return True, None
    except Exception as e:
        return False, str(e)


def edit_mp3(filepath, meta, write_serato):
    # EasyID3 for text fields
    try:
        easy = EasyID3(filepath)
    except ID3Error:
        easy = EasyID3()
        easy.save(filepath)
        easy = EasyID3(filepath)

    if meta.get('title') is not None:
        easy['title'] = [meta['title']]
    if meta.get('artist') is not None:
        easy['artist'] = [meta['artist']]
    if meta.get('album') is not None:
        easy['album'] = [meta['album']]
    if meta.get('genre') is not None:
        easy['genre'] = [meta['genre']]
    if meta.get('year') is not None:
        easy['date'] = [str(meta['year'])]
    if meta.get('composer') is not None:
        easy['composer'] = [meta['composer']]
    if meta.get('grouping') is not None:
        easy['grouping'] = [meta['grouping']]
    easy.save()

    # Raw ID3 for BPM, key, CRATECLOUD_ID, and frames not available via EasyID3
    raw = ID3(filepath)
    if meta.get('bpm') is not None:
        raw['TBPM'] = TBPM(encoding=3, text=str(int(float(meta['bpm']))))
    if meta.get('key') is not None:
        raw['TKEY'] = TKEY(encoding=3, text=str(meta['key']))
    if meta.get('remixer') is not None:
        raw['TPE4'] = TPE4(encoding=3, text=str(meta['remixer']))
    if meta.get('label') is not None:
        raw['TPUB'] = TPUB(encoding=3, text=str(meta['label']))
    if meta.get('comment') is not None:
        raw['COMM::eng'] = COMM(encoding=3, lang='eng', desc='', text=str(meta['comment']))
    if meta.get('cratecloud_id') is not None:
        raw['TXXX:CRATECLOUD_ID'] = TXXX(encoding=3, desc='CRATECLOUD_ID', text=str(meta['cratecloud_id']))
    raw.save()

    return _try_serato_autotags(filepath, meta, write_serato, supported=True)


def edit_flac(filepath, meta, write_serato):
    audio = FLAC(filepath)
    if meta.get('title') is not None:
        audio['title'] = [meta['title']]
    if meta.get('artist') is not None:
        audio['artist'] = [meta['artist']]
    if meta.get('album') is not None:
        audio['album'] = [meta['album']]
    if meta.get('genre') is not None:
        audio['genre'] = [meta['genre']]
    if meta.get('year') is not None:
        audio['date'] = [str(meta['year'])]
    if meta.get('bpm') is not None:
        audio['bpm'] = [str(int(float(meta['bpm'])))]
    if meta.get('key') is not None:
        audio['key'] = [str(meta['key'])]
    if meta.get('remixer') is not None:
        audio['remixer'] = [meta['remixer']]
    if meta.get('grouping') is not None:
        audio['grouping'] = [meta['grouping']]
    if meta.get('composer') is not None:
        audio['composer'] = [meta['composer']]
    if meta.get('comment') is not None:
        audio['comment'] = [meta['comment']]
    if meta.get('label') is not None:
        audio['organization'] = [meta['label']]
    if meta.get('cratecloud_id') is not None:
        # Vorbis comment key lookups are case-insensitive in mutagen (both
        # sides are lowercased), so this stays compatible with analyze.py's
        # read of the lowercase 'cratecloud_id' key.
        audio['CRATECLOUD_ID'] = [str(meta['cratecloud_id'])]
    audio.save()

    # serato-tools' TrackAutotags only implements Serato's MP3/AIFF encoding
    # (a GEOB frame inside an ID3 tag). Serato's real on-disk format for FLAC
    # is different — a base64-encoded blob in a Vorbis comment (see this
    # package's own track_tagdump.py, which decodes that format for FLAC/MP4
    # but has no corresponding writer) — so TrackAutotags(filepath) against a
    # .flac path doesn't recognize the extension and raises. Marking this
    # unsupported rather than reverse-engineering that format and risking
    # writing a Serato Autotags blob that looks successful here but is
    # invalid or corrupt when Serato itself reads it.
    return _try_serato_autotags(filepath, meta, write_serato, supported=False)


def edit_m4a(filepath, meta, write_serato):
    audio = MP4(filepath)
    if audio.tags is None:
        audio.add_tags()
    t = audio.tags
    if meta.get('title') is not None:
        t['\xa9nam'] = [meta['title']]
    if meta.get('artist') is not None:
        t['\xa9ART'] = [meta['artist']]
    if meta.get('album') is not None:
        t['\xa9alb'] = [meta['album']]
    if meta.get('genre') is not None:
        t['\xa9gen'] = [meta['genre']]
    if meta.get('year') is not None:
        t['\xa9day'] = [str(meta['year'])]
    if meta.get('bpm') is not None:
        t['tmpo'] = [int(float(meta['bpm']))]
    if meta.get('composer') is not None:
        t['\xa9wrt'] = [meta['composer']]
    if meta.get('grouping') is not None:
        t['\xa9grp'] = [meta['grouping']]
    if meta.get('comment') is not None:
        t['\xa9cmt'] = [meta['comment']]
    if meta.get('key') is not None:
        t[MP4_KEY_KEY] = [MP4FreeForm(str(meta['key']).encode('utf-8'))]
    if meta.get('label') is not None:
        t[MP4_LABEL_KEY] = [MP4FreeForm(str(meta['label']).encode('utf-8'))]
    if meta.get('remixer') is not None:
        t[MP4_REMIXER_KEY] = [MP4FreeForm(str(meta['remixer']).encode('utf-8'))]
    if meta.get('cratecloud_id') is not None:
        t[MP4_CRATECLOUD_KEY] = [MP4FreeForm(str(meta['cratecloud_id']).encode('utf-8'))]
    audio.save()

    # Serato Autotags aren't written for M4A — same as v2.
    return _try_serato_autotags(filepath, meta, write_serato, supported=False)


def edit_aiff(filepath, meta, write_serato):
    # AIFF's ID3 chunk uses the same frame classes/IDs as MP3 — mutagen.aiff
    # exposes it as a plain ID3-compatible `.tags`, so this mirrors edit_mp3's
    # raw-ID3 half rather than needing format-specific frame mapping.
    audio = AIFF(filepath)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    if meta.get('title') is not None:
        tags['TIT2'] = TIT2(encoding=3, text=str(meta['title']))
    if meta.get('artist') is not None:
        tags['TPE1'] = TPE1(encoding=3, text=str(meta['artist']))
    if meta.get('album') is not None:
        tags['TALB'] = TALB(encoding=3, text=str(meta['album']))
    if meta.get('genre') is not None:
        tags['TCON'] = TCON(encoding=3, text=str(meta['genre']))
    if meta.get('year') is not None:
        tags['TDRC'] = TDRC(encoding=3, text=str(meta['year']))
    if meta.get('composer') is not None:
        tags['TCOM'] = TCOM(encoding=3, text=str(meta['composer']))
    if meta.get('grouping') is not None:
        tags['TIT1'] = TIT1(encoding=3, text=str(meta['grouping']))
    if meta.get('bpm') is not None:
        tags['TBPM'] = TBPM(encoding=3, text=str(int(float(meta['bpm']))))
    if meta.get('key') is not None:
        tags['TKEY'] = TKEY(encoding=3, text=str(meta['key']))
    if meta.get('remixer') is not None:
        tags['TPE4'] = TPE4(encoding=3, text=str(meta['remixer']))
    if meta.get('label') is not None:
        tags['TPUB'] = TPUB(encoding=3, text=str(meta['label']))
    if meta.get('comment') is not None:
        tags['COMM::eng'] = COMM(encoding=3, lang='eng', desc='', text=str(meta['comment']))
    if meta.get('cratecloud_id') is not None:
        tags['TXXX:CRATECLOUD_ID'] = TXXX(encoding=3, desc='CRATECLOUD_ID', text=str(meta['cratecloud_id']))
    audio.save()

    # serato-tools' TrackAutotags dispatches ".aiff" by extension to the same
    # ID3/GEOB encoding it uses for MP3 (AIFF's tags are a plain ID3 chunk),
    # and this was verified working once a real ID3 tag is present on disk —
    # which is guaranteed here since add_tags()+audio.save() ran just above.
    return _try_serato_autotags(filepath, meta, write_serato, supported=True)


def edit_wav(filepath, meta, write_serato):
    # WAV's tags live in an ID3 chunk inside the RIFF container — mutagen.wave
    # exposes it as the same ID3-compatible `.tags` as AIFF, so this mirrors
    # edit_aiff's frame mapping.
    audio = WAVE(filepath)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags

    if meta.get('title') is not None:
        tags['TIT2'] = TIT2(encoding=3, text=str(meta['title']))
    if meta.get('artist') is not None:
        tags['TPE1'] = TPE1(encoding=3, text=str(meta['artist']))
    if meta.get('album') is not None:
        tags['TALB'] = TALB(encoding=3, text=str(meta['album']))
    if meta.get('genre') is not None:
        tags['TCON'] = TCON(encoding=3, text=str(meta['genre']))
    if meta.get('year') is not None:
        tags['TDRC'] = TDRC(encoding=3, text=str(meta['year']))
    if meta.get('composer') is not None:
        tags['TCOM'] = TCOM(encoding=3, text=str(meta['composer']))
    if meta.get('grouping') is not None:
        tags['TIT1'] = TIT1(encoding=3, text=str(meta['grouping']))
    if meta.get('bpm') is not None:
        tags['TBPM'] = TBPM(encoding=3, text=str(int(float(meta['bpm']))))
    if meta.get('key') is not None:
        tags['TKEY'] = TKEY(encoding=3, text=str(meta['key']))
    if meta.get('remixer') is not None:
        tags['TPE4'] = TPE4(encoding=3, text=str(meta['remixer']))
    if meta.get('label') is not None:
        tags['TPUB'] = TPUB(encoding=3, text=str(meta['label']))
    if meta.get('comment') is not None:
        tags['COMM::eng'] = COMM(encoding=3, lang='eng', desc='', text=str(meta['comment']))
    if meta.get('cratecloud_id') is not None:
        tags['TXXX:CRATECLOUD_ID'] = TXXX(encoding=3, desc='CRATECLOUD_ID', text=str(meta['cratecloud_id']))
    audio.save()

    # serato-tools dispatches TrackAutotags by filename extension and doesn't
    # recognize ".wav", so pass the just-saved ID3 chunk directly (a fresh
    # reload, same reasoning as edit_mp3's raw-ID3-after-easy.save() reload)
    # rather than the filepath string.
    reloaded = WAVE(filepath)
    return _try_serato_autotags(reloaded.tags, meta, write_serato, supported=True)


_WRITERS = {
    '.mp3': edit_mp3,
    '.flac': edit_flac,
    '.m4a': edit_m4a,
    '.aiff': edit_aiff,
    '.aif': edit_aiff,
    '.wav': edit_wav,
}


def _read_cratecloud_id(filepath, ext):
    """
    Read an existing CRATECLOUD_ID tag, or None. Read-only — never creates
    or modifies the file, including never adding an ID3/tags block where
    one doesn't already exist.
    """
    try:
        if ext in ('.mp3', '.aiff', '.aif', '.wav'):
            if ext == '.mp3':
                tags = ID3(filepath)
            elif ext == '.wav':
                tags = WAVE(filepath).tags
            else:
                tags = AIFF(filepath).tags
            if tags is None:
                return None
            frame = tags.get('TXXX:CRATECLOUD_ID')
            return str(frame.text[0]) if frame and frame.text else None
        if ext == '.flac':
            val = FLAC(filepath).get('CRATECLOUD_ID')
            return str(val[0]) if val else None
        if ext == '.m4a':
            audio = MP4(filepath)
            val = (audio.tags or {}).get(MP4_CRATECLOUD_KEY)
            if not val:
                return None
            raw = val[0]
            return raw.decode('utf-8', errors='ignore') if isinstance(raw, bytes) else str(raw)
    except Exception:
        return None
    return None


def _atomic_edit(filepath, ext, write_fn, meta, write_serato):
    """
    Copies filepath to a temp file in the same directory (same volume, so
    the final swap is atomic), runs write_fn against the copy, fsyncs it,
    then os.replace()s it over the original. On any failure the temp file
    is removed and the original is left byte-for-byte untouched.

    mtime is deliberately NOT preserved — os.replace leaves the temp file's
    (i.e. just-written) mtime on the final path, since the live folder
    watcher needs to see this as a real change.

    TODO(cratecloud): the watcher will pick this up as a file change (new
    mtime, possibly a different size) and may queue a rescan. Reconcile
    must treat a size delta coming from a tag edit as the same track
    (matched by client_uuid/partial_hash), not bounce it into "new file"
    handling — only the tag payload changed, not the track's identity.
    """
    directory = os.path.dirname(filepath) or '.'
    fd, tmp_path = tempfile.mkstemp(prefix='.cratecloud_edit_', suffix=ext, dir=directory)
    os.close(fd)
    try:
        shutil.copyfile(filepath, tmp_path)
        os.chmod(tmp_path, os.stat(filepath).st_mode)

        result = write_fn(tmp_path, meta, write_serato)

        with open(tmp_path, 'rb') as f:
            os.fsync(f.fileno())

        os.replace(tmp_path, filepath)
        return result
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def edit_file(filepath, meta, write_serato=True):
    if not os.path.exists(filepath):
        return {'success': False, 'error': f'File not found: {filepath}', 'filepath': filepath}

    ext = os.path.splitext(filepath)[1].lower()
    if ext not in SUPPORTED:
        return {'success': False, 'error': f'Unsupported format: {ext}', 'filepath': filepath}

    cratecloud_id = meta.get('cratecloud_id')
    if cratecloud_id is not None:
        existing = _read_cratecloud_id(filepath, ext)
        if existing is not None and existing != str(cratecloud_id):
            return {
                'success': False,
                'error': 'cratecloud_id_conflict',
                'existing': existing,
                'filepath': filepath
            }

    try:
        wrote_serato, serato_error = _atomic_edit(filepath, ext, _WRITERS[ext], meta, write_serato)
        result = {'success': True, 'filepath': filepath, 'serato_written': wrote_serato}
        if serato_error is not None:
            result['serato_error'] = serato_error
        return result
    except Exception as e:
        return {'success': False, 'error': str(e), 'filepath': filepath}


def process_batch(write_serato):
    """
    Reads NDJSON {"filepath": ..., "meta": {...}} objects from stdin, one
    per line, and writes one JSON result line to stdout per input in the
    same order — flushed immediately so a caller (sidecar.ts) can stream
    progress instead of waiting for the whole batch to finish. One bad
    line or file failure is captured into its own result and never aborts
    the rest of the batch.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        filepath = None
        try:
            item = json.loads(line)
            filepath = item.get('filepath')
            meta = item.get('meta', {})
            if not filepath:
                raise ValueError('missing "filepath"')
            result = edit_file(filepath, meta, write_serato=write_serato)
        except Exception as e:
            result = {'success': False, 'error': str(e), 'filepath': filepath}

        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Edit metadata on an audio file.')
    parser.add_argument('filepath', nargs='?', help='Path to the audio file (omit with --batch)')
    parser.add_argument('--meta', help='JSON object of fields to write (single-file mode)')
    parser.add_argument('--batch', action='store_true',
                         help='Read NDJSON {filepath, meta} objects from stdin')
    parser.add_argument('--no-serato', action='store_true', help='Skip Serato tag writing')
    args = parser.parse_args()

    if args.batch:
        process_batch(write_serato=not args.no_serato)
    else:
        if not args.filepath or args.meta is None:
            parser.error('filepath and --meta are required unless --batch is given')
        meta = json.loads(args.meta)
        result = edit_file(args.filepath, meta, write_serato=not args.no_serato)
        print(json.dumps(result))
