"""
Writes ISRC / MusicBrainz recording id tags into an audio file the way real
taggers do, one format at a time, so specs can check the sidecar reads them.

Usage: write_identity.py <file> [--isrc VALUE] [--mbid VALUE]
"""
import argparse
import os

from mutagen.id3 import ID3, TSRC, UFID, ID3NoHeaderError
from mutagen.flac import FLAC
from mutagen.mp4 import MP4, MP4FreeForm


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('filepath')
    parser.add_argument('--isrc')
    parser.add_argument('--mbid')
    args = parser.parse_args()
    path = args.filepath
    ext = os.path.splitext(path)[1].lower()

    if ext in ('.mp3', '.aiff', '.wav'):
        if ext == '.mp3':
            try:
                tags = ID3(path)
            except ID3NoHeaderError:
                tags = ID3()
            target = path
        else:
            from mutagen.aiff import AIFF
            from mutagen.wave import WAVE
            audio = AIFF(path) if ext == '.aiff' else WAVE(path)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
            target = None
        if args.isrc:
            tags.add(TSRC(encoding=3, text=[args.isrc]))
        if args.mbid:
            # Where MusicBrainz Picard puts the recording id in ID3.
            tags.add(UFID(owner='http://musicbrainz.org', data=args.mbid.encode('ascii')))
        if target:
            tags.save(target)
        else:
            audio.save()
    elif ext == '.flac':
        audio = FLAC(path)
        if args.isrc:
            audio['ISRC'] = args.isrc
        if args.mbid:
            audio['MUSICBRAINZ_TRACKID'] = args.mbid
        audio.save()
    elif ext in ('.m4a', '.mp4'):
        audio = MP4(path)
        if audio.tags is None:
            audio.add_tags()
        if args.isrc:
            audio.tags['----:com.apple.iTunes:ISRC'] = [
                MP4FreeForm(args.isrc.encode('utf-8'))]
        if args.mbid:
            audio.tags['----:com.apple.iTunes:MusicBrainz Track Id'] = [
                MP4FreeForm(args.mbid.encode('utf-8'))]
        audio.save()
    else:
        raise SystemExit('unsupported: ' + ext)


if __name__ == '__main__':
    main()
