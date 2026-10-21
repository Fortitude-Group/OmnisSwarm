/**
 * Renders the golden cases to PNG and SVG so the designer can see colours, not just glyphs:
 *   node scripts/preview.ts [outDir]        (default .superpowers/preview, git-ignored)
 * Blocks and braille are drawn exactly; any other glyph is drawn as a soft bar (read the words in the golden file).
 * A blank row between the two grids stands for the chip row. Development only; not shipped in the plugin's mod.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { DEFAULT } from '../src/render/color.ts'
import type { Grid } from '../src/render/grid.ts'
import { CELL_H, CELL_W, blockShape, gridToSvg } from '../src/render/svg.ts'
import { GOLDEN_CASES, goldenFrame } from '../tests/render/golden-cases.ts'

const DOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

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

function paint(grids: readonly Grid[]): { width: number; height: number; rgb: Uint8Array } {
  const width = Math.max(...grids.map(g => g.columns)) * CELL_W
  const height = (grids.reduce((n, g) => n + g.rows, 0) + grids.length - 1) * CELL_H
  const rgb = new Uint8Array(width * height * 3)
  const fill = (x: number, y: number, w: number, h: number, c: number, a = 1) => {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const i = (yy * width + xx) * 3
        rgb[i] = Math.round(rgb[i]! * (1 - a) + ((c >>> 16) & 255) * a)
        rgb[i + 1] = Math.round(rgb[i + 1]! * (1 - a) + ((c >>> 8) & 255) * a)
        rgb[i + 2] = Math.round(rgb[i + 2]! * (1 - a) + (c & 255) * a)
      }
    }
  }
  let oy = 0
  for (const g of grids) {
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.columns; cx++) {
        const x = cx * CELL_W
        const y = oy + cy * CELL_H
        const bg = g.bg(cx, cy)
        const fg = g.fg(cx, cy) === DEFAULT ? 0xc9d1d9 : g.fg(cx, cy)
        const code = g.glyph(cx, cy)
        if (bg !== DEFAULT) fill(x, y, CELL_W, CELL_H, bg)
        const shape = blockShape(code)
        if (shape !== null) fill(x + shape[0] * CELL_W, y + shape[1] * CELL_H, shape[2] * CELL_W, shape[3] * CELL_H, fg, shape[4])
        else if (code > 0x2800 && code <= 0x28ff) {
          DOTS.forEach(([col, row], bit) => {
            if (((code - 0x2800) >> bit) & 1) fill(x + col * 4 + 1, y + row * 4 + 1, 2, 2, fg)
          })
        } else if (code !== 0x20) fill(x + 1, y + 4, CELL_W - 2, CELL_H - 8, fg, 0.6)
      }
    }
    oy += (g.rows + 1) * CELL_H
  }
  return { width, height, rgb }
}

const out = resolve(process.argv[2] ?? '.superpowers/preview')
mkdirSync(out, { recursive: true })
for (const c of GOLDEN_CASES) {
  const f = goldenFrame(c)
  const grids = f.bottom === null ? [f.top] : [f.top, f.bottom]
  const picture = paint(grids)
  writeFileSync(join(out, `${c.name}.png`), png(picture.width, picture.height, picture.rgb))
  grids.forEach((g, i) => {
    const svg = gridToSvg(g, f.alt, Number.MAX_SAFE_INTEGER)
    if (svg !== null) writeFileSync(join(out, `${c.name}-${i === 0 ? 'top' : 'bottom'}.svg`), svg)
  })
  console.log(`${c.name}: ${picture.width}x${picture.height} -> ${join(out, `${c.name}.png`)}`)
}
