# fpcalc (Chromaprint) — third-party notice

DeepCrated includes `fpcalc` 1.6.1, the command-line tool from the
Chromaprint project, unmodified, as a separate program. DeepCrated runs it
in its own process to compute audio fingerprints; it is not linked into
DeepCrated.

- Project: Chromaprint — https://acoustid.org/chromaprint
- Binary: official release build, https://github.com/acoustid/chromaprint/releases/tag/v1.6.1
- Source code for this exact version: https://github.com/acoustid/chromaprint/archive/refs/tags/v1.6.1.tar.gz

## Licence

Chromaprint's own source code is MIT-licensed. The `fpcalc` binary also
contains FFmpeg 8.0, statically linked, so as a whole it is distributed
under the **GNU Lesser General Public License, version 2.1**
(`LGPL-2.1.txt`, alongside this file). See `CHROMAPRINT-LICENSE.md` for the
project's own licence statement.

FFmpeg in this build was configured without `--enable-gpl`,
`--enable-nonfree` or `--enable-version3` (LGPL 2.1 or later), and decodes
audio only.

- FFmpeg: https://ffmpeg.org — source: https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz
- Build configuration used for the release binaries:
  https://github.com/acoustid/ffmpeg-build/tree/v8.0-1 (`common.sh`) and
  https://github.com/acoustid/chromaprint/blob/v1.6.1/package/build.sh

On macOS the FFT is Apple's Accelerate framework (part of the operating
system); on Windows and Linux it is FFmpeg's own. FFTW is not used.

## Source offer

You may obtain the complete corresponding source code for Chromaprint 1.6.1
and FFmpeg 8.0 used in this binary from the links above. If any link stops
working, contact DeepCrated and we will provide the source on request, for
at least three years after we last distribute this version.
