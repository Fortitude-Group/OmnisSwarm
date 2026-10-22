/** Draws assets/icon.png from the pixel grid in assets/icon.grid.txt. `node scripts/build-icon.ts`. No dependencies. */
import { readFileSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const GRID = 'assets/icon.grid.txt'
const OUT = 'assets/icon.png'

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

const lines = readFileSync(GRID, 'utf8').replace(/\r/g, '').split('\n')
let w = 0
let h = 0
let scale = 1
const legend = new Map<string, [number, number, number]>()
const rows: string[] = []
let inGrid = false
for (const line of lines) {
  if (inGrid) {
    if (line !== '') rows.push(line)
    continue
  }
  if (line === '' || line.startsWith('#')) continue
  const [word, a, b] = line.split(' ')
  if (word === 'size') [w, h] = [Number(a), Number(b)]
  else if (word === 'scale') scale = Number(a)
  else if (word === 'legend' && a !== undefined && b !== undefined && /^#[0-9a-f]{6}$/i.test(b)) legend.set(a, [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16)) as [number, number, number])
  else if (word === 'grid') inGrid = true
  else throw new Error(`${GRID}: can't read "${line}"`)
}
if (rows.length !== h) throw new Error(`${GRID}: ${rows.length} rows, expected ${h}`)
const size = w * scale
if (w !== h || size < 512 || size > 2048) throw new Error(`${GRID}: icon must be square and 512 to 2048 px, got ${w * scale}x${h * scale}`)
const rgb = new Uint8Array(size * size * 3)
rows.forEach((row, y) => {
  if (row.length !== w) throw new Error(`${GRID}: row ${y + 1} is ${row.length} wide, expected ${w}`)
  for (let x = 0; x < w; x++) {
    const c = legend.get(row[x]!)
    if (c === undefined) throw new Error(`${GRID}: row ${y + 1} has "${row[x]}", which has no legend entry`)
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) rgb.set(c, ((y * scale + dy) * size + x * scale + dx) * 3)
  }
})
writeFileSync(OUT, png(size, size, rgb))
console.log(`${OUT}: ${size}x${size}`)
