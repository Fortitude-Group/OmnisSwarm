/** GIF's variable-width LZW: codes from minCodeSize+1 bits up to 12, packed least significant bit first. */
export function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out: number[] = []
  let size = minCodeSize + 1
  let next = eoi + 1
  let dict = new Map<number, number>()
  let buf = 0
  let count = 0
  const emit = (code: number): void => {
    buf |= code << count
    count += size
    while (count >= 8) {
      out.push(buf & 255)
      buf >>>= 8
      count -= 8
    }
  }
  emit(clear)
  if (indices.length > 0) {
    let prefix = indices[0]!
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!
      const key = prefix * 256 + k
      const found = dict.get(key)
      if (found !== undefined) {
        prefix = found
        continue
      }
      emit(prefix)
      if (next === 4096) {
        emit(clear)
        dict = new Map()
        size = minCodeSize + 1
        next = eoi + 1
      } else {
        if (next >= 1 << size) size++
        dict.set(key, next++)
      }
      prefix = k
    }
    emit(prefix)
  }
  emit(eoi)
  if (count > 0) out.push(buf & 255)
  return Uint8Array.from(out)
}
