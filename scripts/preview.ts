/**
 * Renders the golden cases to PNG and SVG so the designer can see colours, not just glyphs:
 *   node scripts/preview.ts [outDir]        (default .superpowers/preview, git-ignored)
 * Blocks and braille are drawn exactly; any other glyph is drawn as a soft bar (read the words in the golden file).
 * A blank row between the two grids stands for the chip row. Development only; not shipped in the plugin's mod.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { paintGrids } from '../src/render/raster.ts'
import { gridToSvg } from '../src/render/svg.ts'
import { GOLDEN_CASES, goldenFrame } from '../tests/render/golden-cases.ts'
import { robotSheet } from '../tests/render/robot-sheet.ts'

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1)
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const out = resolve(process.argv[2] ?? '.superpowers/preview')
mkdirSync(out, { recursive: true })
for (const c of GOLDEN_CASES) {
  const f = goldenFrame(c)
  const grids = f.bottom === null ? [f.top] : [f.top, f.bottom]
  const picture = paintGrids(grids)
  writeFileSync(join(out, `${c.name}.png`), png(picture.width, picture.height, picture.rgb))
  grids.forEach((g, i) => {
    const svg = gridToSvg(g, f.alt, Number.MAX_SAFE_INTEGER)
    if (svg !== null) writeFileSync(join(out, `${c.name}-${i === 0 ? 'top' : 'bottom'}.svg`), svg)
  })
  console.log(`${c.name}: ${picture.width}x${picture.height} -> ${join(out, `${c.name}.png`)}`)
}

// The robot size x state sheet (tests/render/robot-sheet.ts), for the robot goldens.
const sheet = paintGrids([robotSheet()])
writeFileSync(join(out, 'robot-sheet.png'), png(sheet.width, sheet.height, sheet.rgb))
console.log(`robot-sheet: ${sheet.width}x${sheet.height} -> ${join(out, 'robot-sheet.png')}`)
