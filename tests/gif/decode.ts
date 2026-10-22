/** A small GIF89a reader for the encoder's tests: global palette, frames, LZW. Not shipped. */
export function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out = new Uint8Array(count)
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
  }
  const stack = new Uint8Array(4097)
  let size = minCodeSize + 1
  let next = eoi + 1
  let prev = -1
  let bits = 0
  let nbits = 0
  let p = 0
  let op = 0
  for (;;) {
    while (nbits < size) {
      if (p >= data.length) return out.subarray(0, op)
      bits |= data[p++]! << nbits
      nbits += 8
    }
    const code = bits & ((1 << size) - 1)
    bits >>>= size
    nbits -= size
    if (code === clear) {
      size = minCodeSize + 1
      next = eoi + 1
      prev = -1
      continue
    }
    if (code === eoi) break
    if (prev === -1) {
      out[op++] = suffix[code]!
      prev = code
      continue
    }
    let sp = 0
    let c = code
    if (code >= next) {
      stack[sp++] = first[prev]!
      c = prev
    }
    while (c >= clear) {
      stack[sp++] = suffix[c]!
      c = prefix[c]!
    }
    stack[sp++] = c
    const head = c
    while (sp > 0 && op < count) out[op++] = stack[--sp]!
    if (next < 4096) {
      prefix[next] = prev
      suffix[next] = head
      first[next] = first[prev]!
      next++
      if (next === 1 << size && size < 12) size++
    }
    prev = code
  }
  return out.subarray(0, op)
}

export type Decoded = { width: number; height: number; palette: number[]; frames: Array<{ x: number; y: number; w: number; h: number; delayCs: number; transparent: number | null; disposal: number; pixels: Uint8Array }>; loops: boolean }

export function decodeGif(b: Uint8Array): Decoded {
  const u16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  if (String.fromCharCode(...b.subarray(0, 6)) !== 'GIF89a') throw new Error('not GIF89a')
  const width = u16(6)
  const height = u16(8)
  const packed = b[10]!
  const gct = 2 << (packed & 7)
  const palette: number[] = []
  let p = 13
  for (let i = 0; i < gct; i++, p += 3) palette.push((b[p]! << 16) | (b[p + 1]! << 8) | b[p + 2]!)
  const frames: Decoded['frames'] = []
  let gce = { delayCs: 0, transparent: null as number | null, disposal: 0 }
  let loops = false
  const blocks = (): Uint8Array => {
    const parts: number[] = []
    for (let n = b[p++]!; n > 0; n = b[p++]!) {
      for (let i = 0; i < n; i++) parts.push(b[p + i]!)
      p += n
    }
    return Uint8Array.from(parts)
  }
  for (;;) {
    const tag = b[p++]
    if (tag === 0x3b) break
    if (tag === 0x21) {
      const label = b[p++]
      if (label === 0xf9) {
        const flags = b[p + 1]!
        gce = { delayCs: u16(p + 2), transparent: flags & 1 ? b[p + 4]! : null, disposal: (flags >> 2) & 7 }
        p += 6
      } else {
        const body = blocks()
        if (label === 0xff && String.fromCharCode(...body.subarray(0, 11)) === 'NETSCAPE2.0') loops = true
      }
      continue
    }
    if (tag !== 0x2c) throw new Error(`bad block ${tag}`)
    const x = u16(p)
    const y = u16(p + 2)
    const w = u16(p + 4)
    const h = u16(p + 6)
    p += 9
    const min = b[p++]!
    frames.push({ x, y, w, h, ...gce, pixels: lzwDecode(blocks(), min, w * h) })
  }
  return { width, height, palette, frames, loops }
}
