// Standalone, read-only verification script — no project dependency, no DB
// writes, no import pipeline. Run with:
//   npx tsx scripts/serato-dump.ts <_Serato_ dir> <volume root> <out.json>
// Dumps every `database V2` track through our own reader so its output can
// be diffed against a known-good parser (see the seratolibraryparser
// comparison this script's output feeds).
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { readSeratoTracks, defaultDatabaseVPath } from '../src/main/serato/seratoDatabase'

async function main(): Promise<void> {
  const [, , seratoDir, volumeRoot, outPath] = process.argv
  if (!seratoDir || !volumeRoot || !outPath) {
    console.error('usage: npx tsx scripts/serato-dump.ts <_Serato_ dir> <volume root> <out.json>')
    process.exit(1)
  }

  const databaseVPath = defaultDatabaseVPath(seratoDir)

  const tracks: Record<string, unknown>[] = []
  for await (const entry of readSeratoTracks(databaseVPath)) {
    const resolvedPath = join(volumeRoot, entry.relativePath)
    tracks.push({ ...entry, resolvedPath })
  }

  await writeFile(
    outPath,
    JSON.stringify(
      {
        databaseVPath,
        volumeRoot,
        trackCount: tracks.length,
        tracks
      },
      null,
      2
    )
  )

  console.log(`Read ${tracks.length} tracks from ${databaseVPath}`)
  console.log(`Wrote ${outPath}`)
}

main()
