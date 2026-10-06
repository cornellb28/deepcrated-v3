#!.user/bin/env python3  shebang - If you execute this file directly, use Python 3 to run it.
"""
CrateCloud audio sidecar — analyze.py
Reads BPM and key from an audio file.
Returns a single JSON object to stdout.
Electron reads that JSON via child_process.

Usage:
    python3 analyze.py /path/to/track.mp3
"""

import sys
import json # lets Python convert Python objects into JSON
import warnings # Don't show warning messages. Because your Electron process is expecting clean JSON on stdout.
import os
import argparse

# Suppose librosa warnings - safe to ignore
warnings.filterwarnings('ignore')

import subprocess
import numpy as np
import librosa # analyzes the actual audio waveform
import mutagen # reads the metadata embedded in the music file
import base64
from mutagen.id3 import ID3, TBPM, TKEY
from mutagen.flac import FLAC
from mutagen.mp4 import MP4
from mutagen.mp3 import MP3
from mutagen.easyid3 import EasyID3

# ─── Camelot Wheel ───────────────────────────────────────
# Maps librosa key names to Camelot notation
# librosa returns keys like "C major" or "A minor"
# DJs use Camelot: "8B" or "8A"

CAMELOT = {
    'C major':  '8B',  'G major':  '9B',
    'D major':  '10B', 'A major':  '11B',
    'E major':  '12B', 'B major':  '1B',
    'F# major': '2B',  'Db major': '3B',
    'Ab major': '4B',  'Eb major': '5B',
    'Bb major': '6B',  'F major':  '7B',
    'A minor':  '8A',  'E minor':  '9A',
    'B minor':  '10A', 'F# minor': '11A',
    'C# minor': '12A', 'G# minor': '1A',
    'Eb minor': '2A',  'Bb minor': '3A',
    'F minor':  '4A',  'C minor':  '5A',
    'G minor':  '6A',  'D minor':  '7A',
}

def format_duration(duration_sec: float | None) -> str | None:
    """Convert seconds to a MM:SS string. Returns None if input is None."""
    if duration_sec is None:
        return None
    total_seconds = int(duration_sec)
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f'{minutes}:{seconds:02d}'

def detect_bpm(y, sr):
  """
  Detect the tempo (BPM) of an audio signal.
  y  = audio time series (numpy array)
  sr = sample rate (integer)
  Returns a float rounded to 1 decimal place.
  """

  # onset_envelope gives librosa rhythmic context
  onset_env = librosa.onset.onset_strength(y=y, sr=sr)

  # beat_track return (tempo, beat_frames)
  # tempo is a numpy array = we take the first element
  tempo, _ = librosa.beat.beat_track( onset_envelope=onset_env,sr=sr)

  # Convert numpy float to Python float and round
  bpm = float(tempo[0] if hasattr(tempo, '__len__') else float(tempo))
  return round(bpm, 1)

def detect_key(y, sr):
  """
  Detect the musical key of an audio signal.
  Returns a dict with full name and Camelot notation.
  """
  # Separate harmonic content from percussion
  # This improves key detection accuracy
  y_harmonic, _ = librosa.effects.hpss(y)

  # Chromagram — energy at each of the 12 pitch classes
  chroma = librosa.feature.chroma_cqt(y=y_harmonic, sr=sr)

  #Average energy across time
  chroma_mean = chroma.mean(axis=1)

  # Krumhansl-Kessler key profiles
  # These are the "fingerprints" of each key
  major_profile = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
    2.52, 5.19, 2.39, 3.66, 2.29, 2.88
  ]
  minor_profile = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
    2.54, 4.75, 3.98, 2.69, 3.34, 3.17
  ]

  key_names = [
    'C', 'C#', 'D', 'Eb', 'E', 'F',
    'F#', 'G', 'Ab', 'A', 'Bb', 'B'
  ]

  minor_names = [
    'A', 'Bb', 'B', 'C', 'C#', 'D',
    'Eb', 'E', 'F', 'F#', 'G', 'Ab'
  ]

  import numpy as np

  best_score = -1
  best_key = 'C major'

  # Try all 12 major keys
  for i in range(12):
    profile = np.roll(major_profile, i)
    score = np.corrcoef(chroma_mean, profile)[0, 1]
    if score > best_score:
        best_score = score
        best_key = f'{key_names[i]} major'

  # Try all 12 minor keys
  for i in range(12):
    profile = np.roll(minor_profile, i)
    score = np.corrcoef(chroma_mean, profile)[0, 1]
    if score > best_score:
        best_score = score
        best_key = f'{minor_names[i]} minor'

  camelot = CAMELOT.get(best_key, '?')

  return {
        'key_full':     best_key,
        'key_camelot':  camelot,
    }

def _extract_tags(filepath):
    """
    Read existing ID3 tags from the file using mutagen.
    Fast — does not load the full audio into memory.
    Returns a dict of whatever tags exist.
    """
    tags = {
        'title':       None,
        'artist':      None,
        'album':       None,
        'genre':       None,
        'year':        None,
        'comment':     None,
        'label':       None,
        'remixer':     None,
        'composer':    None,
        'grouping':    None,
        'bpm_tag':     None,  # BPM already in the file's tags
        'client_uuid': None,  # CRATECLOUD_ID, if a previous session wrote one — read-only for now
    }

    try:
        audio = mutagen.File(filepath)
        if audio is None or audio.tags is None:
            return tags

        # mutagen tag keys differ by format
        # This covers MP3 (ID3), FLAC, M4A
        def get(keys):
            for key in keys:
                val = audio.tags.get(key)
                if val:
                    # ID3 tags are objects, FLAC tags are lists of str, M4A
                    # freeform (----:) atoms are lists of raw bytes (MP4FreeForm
                    # is a bytes subclass — str() on it gives "b'...'", not the
                    # text, so bytes need an explicit decode instead).
                    raw = val[0] if isinstance(val, list) else val
                    v = raw.decode('utf-8', errors='ignore') if isinstance(raw, bytes) else str(raw)
                    if v.strip():
                        return v.strip()
            return None

        tags['title']       = get(['TIT2', 'title',    '\xa9nam'])
        tags['artist']      = get(['TPE1', 'artist',   '\xa9ART'])
        tags['album']       = get(['TALB', 'album',     '\xa9alb'])
        tags['genre']       = get(['TCON', 'genre',     '\xa9gen'])
        tags['year']        = get(['TDRC', 'date',      '\xa9day'])
        tags['comment']     = get(['COMM::', 'comment', '\xa9cmt'])
        # MP4 carries these two as iTunes freeform atoms — see edit_tags.py's
        # MP4_LABEL_KEY/MP4_REMIXER_KEY for why those names. PUBLISHER is read
        # as a label fallback for files tagged by other software.
        tags['label']       = get(['TPUB', 'organization',
                                    '----:com.apple.iTunes:LABEL',
                                    '----:com.apple.iTunes:PUBLISHER'])
        tags['remixer']     = get(['TPE4', 'remixer',
                                    '----:com.apple.iTunes:REMIXER'])
        tags['composer']    = get(['TCOM', 'composer',  '\xa9wrt'])
        tags['grouping']    = get(['TIT1', 'grouping',  '\xa9grp'])
        tags['bpm_tag']     = get(['TBPM', 'bpm'])
        tags['client_uuid'] = get(['TXXX:CRATECLOUD_ID', 'cratecloud_id',
                                    '----:com.apple.iTunes:CRATECLOUD_ID'])

    except Exception:
        # Partial tag read is fine
        # Return whatever we got
        pass

    return tags

def load_via_ffmpeg(filepath, sr=22050):
    """
    Decode audio with ffmpeg instead of soundfile.
    librosa.load only reads formats libsndfile understands, which
    excludes AAC-in-MP4 (.m4a) — ffmpeg handles those containers.
    Returns mono float32 PCM at the target sample rate.
    """
    cmd = [
        'ffmpeg', '-v', 'error', '-i', filepath,
        '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        message = proc.stderr.decode(errors='ignore').strip() or 'ffmpeg decode failed'
        raise RuntimeError(message)
    y = np.frombuffer(proc.stdout, dtype=np.float32)
    return y, sr

def load_audio(filepath, sr=22050):
    """
    Load audio for analysis. Tries librosa/soundfile first (fast path
    for wav/flac/mp3), falls back to ffmpeg for containers soundfile
    can't decode (e.g. .m4a).
    """
    try:
        return librosa.load(filepath, sr=sr, mono=True)
    except Exception:
        return load_via_ffmpeg(filepath, sr=sr)

def extract_artwork(filepath: str) -> str | None:
    """Return embedded album art as a base64 string, or None if unavailable."""
    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext in ('.mp3', '.wav', '.aiff', '.aif'):
            audio = ID3(filepath)
            for key in audio.keys():
                if key.startswith('APIC'):
                    return base64.b64encode(audio[key].data).decode()
        elif ext == '.flac':
            audio = FLAC(filepath)
            if audio.pictures:
                return base64.b64encode(audio.pictures[0].data).decode()
        elif ext in ('.m4a', '.mp4'):
            audio = MP4(filepath)
            if audio.tags and 'covr' in audio.tags:
                return base64.b64encode(bytes(audio.tags['covr'][0])).decode()
    except Exception:
        pass
    return None

# ── Stage progress ────────────────────────────────────────────────────────
# analyze() is one blocking call that takes seconds on a long track, so it
# reports which stage it is in. This goes to STDERR on purpose: stdout carries
# the single JSON result every caller parses as a whole, and adding lines to it
# would break all of them. sidecar.ts picks these out of the stderr stream by
# the sentinel and leaves the rest (librosa warnings) alone.
#
# `step` counts stages FINISHED, so it is 0 while the first one runs and
# reaches PROGRESS_STEPS when analyze() returns — i.e. step/PROGRESS_STEPS is
# the fraction genuinely complete. The stages are not equal in wall-clock
# time (decode dominates), so the bar advances in uneven jumps rather than
# pretending to be a linear timer.
PROGRESS_SENTINEL = '@@CC_PROGRESS '
PROGRESS_STEPS = 5


def _emit_progress(stage, step):
    print(
        PROGRESS_SENTINEL + json.dumps({'stage': stage, 'step': step, 'steps': PROGRESS_STEPS}),
        file=sys.stderr,
        flush=True,
    )


def analyze(filepath):
    """
    Full analysis pipeline:
    1. Read existing tags (fast)
    2. Load audio (slow)
    3. Detect BPM
    4. Detect key
    5. Return everything as a dict
    """
    import os

    if not os.path.exists(filepath):
        return {
            'success': False,
            'error':   f'File not found: {filepath}'
        }

    # Step 1 — read tags (no audio load needed)
    _emit_progress('tags', 0)
    tags = _extract_tags(filepath)

    # Step 2 — load audio at 22050 Hz mono
    # Lower sample rate = faster load, still accurate for BPM/key
    _emit_progress('decode', 1)
    try:
        y, sr = load_audio(filepath, sr=22050)
    except Exception as e:
        return {
            'success': False,
            'error':   f'Could not load audio: {str(e)}',
            'tags':    tags,
        }

    # Step 3 — BPM
    _emit_progress('bpm', 2)
    try:
        bpm = detect_bpm(y, sr)
    except Exception as e:
        bpm = None
        print(f'BPM detection failed: {e}', file=sys.stderr)

    # Step 4 — Key
    _emit_progress('key', 3)
    try:
        key = detect_key(y, sr)
    except Exception as e:
        key = {'key_full': None, 'key_camelot': None}
        print(f'Key detection failed: {e}', file=sys.stderr)

    # Step 5 — Duration
    duration_sec = round(librosa.get_duration(y=y, sr=sr), 2)
    minutes = int(duration_sec // 60)
    seconds = int(duration_sec % 60)
    duration_str = f'{minutes}:{seconds:02d}'

    # Add artwork extraction
    _emit_progress('artwork', 4)
    artwork_base64 = extract_artwork(filepath)
    _emit_progress('done', PROGRESS_STEPS)

    # Step 6 — Return everything
    # Tags from the file take priority for title/artist/etc.
    # BPM and key come from analysis
    return {
        'success':      True,
        'filepath':     filepath,
        'title':        tags['title'],
        'artist':       tags['artist'],
        'album':        tags['album'],
        'genre':        tags['genre'],
        'year':         tags['year'],
        'comment':      tags['comment'],
        'label':        tags['label'],
        'remixer':      tags['remixer'],
        'composer':     tags['composer'],
        'grouping':     tags['grouping'],
        'bpm':          bpm,
        'key_full':     key['key_full'],
        'key_camelot':  key['key_camelot'],
        'camelot':      key['key_camelot'],
        'duration_sec': duration_sec,
        'duration_str': duration_str,
        'bpm_tag':      tags['bpm_tag'],
        'artwork_base64': artwork_base64,
    }

def read_tags(filepath: str) -> dict:
  """
  Fast import — reads only ID3 tags and artwork.
  No librosa, no audio loading. Runs in milliseconds.
  Used for Phase 1 of the two-phase import.
  """

  if not os.path.exists(filepath):
    return {
      'success': False,
      'error': f'File not found: {filepath}'
    }

  ext = os.path.splitext(filepath)[1].lower()

  tags = _extract_tags(filepath)
  probe = probe_duration(filepath)
  artwork_base64 = extract_artwork(filepath)

  file_size_bytes = os.path.getsize(filepath)
  filename = os.path.basename(filepath)

  return {
    'success':         True,
    'filepath':        filepath,
    'filename':        filename,
    'duration_sec':    probe.get('duration_sec'),
    'duration_str':    format_duration(probe.get('duration_sec')),
    'file_size_bytes': file_size_bytes,
    'format':          ext.lstrip('.').upper(),
    'title':           tags['title'] or os.path.splitext(filename)[0],
    'artist':          tags['artist'],
    'album':           tags['album'],
    'genre':           tags['genre'],
    'year':            tags['year'],
    'comment':         tags['comment'],
    'label':           tags['label'],
    'remixer':         tags['remixer'],
    'composer':        tags['composer'],
    'grouping':        tags['grouping'],
    'bpm':             float(tags['bpm_tag']) if tags['bpm_tag'] else None,
    'key_camelot':     None,
    'key_full':        None,
    'camelot':         None,
    'client_uuid':     tags['client_uuid'],
    'artwork_base64':  artwork_base64,
    'analyzed':        False,   # ← tells main process this needs Phase 2
  }

def write_tags(filepath: str, bpm: float, camelot: str) -> bool:
    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext == '.mp3':
            raw = ID3(filepath)
            raw['TBPM'] = TBPM(encoding=3, text=str(int(round(bpm))))
            raw['TKEY'] = TKEY(encoding=3, text=camelot)
            raw.save()
        elif ext == '.flac':
            audio = FLAC(filepath)
            audio['bpm'] = [str(int(round(bpm)))]
            audio['key'] = [camelot]
            audio.save()
        elif ext == '.m4a':
            audio = MP4(filepath)
            if audio.tags is None:
                audio.add_tags()
            audio.tags['tmpo'] = [int(round(bpm))]
            audio.save()
        else:
            return False
        return True
    except Exception:
        return False

def probe_duration(filepath: str) -> dict:
    """Cheap header-only probe: size + duration via mutagen, no audio decode.
    Used only as a match signal during orphan reconciliation — never for tagging."""
    if not os.path.exists(filepath):
        return {'success': False, 'error': f'File not found: {filepath}', 'filepath': filepath}
    try:
        file_size_bytes = os.path.getsize(filepath)
        audio = mutagen.File(filepath)
        duration_sec = round(float(audio.info.length), 2) if audio and audio.info else None
        return {
            'success': True,
            'filepath': filepath,
            'file_size_bytes': file_size_bytes,
            'duration_sec': duration_sec,
        }
    except Exception as e:
        return {'success': False, 'error': str(e), 'filepath': filepath}


# ─── Entry point ─────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error':   'No file path provided. Usage: python3 analyze.py /path/to/file.mp3'
        }))
        sys.exit(1)

    parser = argparse.ArgumentParser()
    parser.add_argument('filepath', help='Path to audio file')
    parser.add_argument('--fast', action='store_true', help='Fast mode - tags only, no audio analysis')
    args = parser.parse_args()

    if args.fast:
      result = read_tags(args.filepath)
    else:
      result = analyze(args.filepath)

    print(json.dumps(result))




# Electron
#    │
#    │  "Analyze this MP3"
#    ▼
# analyze.py
#    │
#    ├── Read existing metadata
#    │
#    ├── Load audio
#    │
#    ├── Detect BPM
#    │
#    ├── Detect Key
#    │
#    ├── Calculate Duration
#    │
#    └── Build JSON
#           │
#           ▼
#        Electron
