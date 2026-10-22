/** The GIF's one global colour table: index 0 is the transparent colour; colours take indices first-come, then map to the nearest. */
export const TRANSPARENT = 0

export class Palette {
  readonly #colors: number[] = [0x000000]
  readonly #index = new Map<number, number>()

  get size(): number {
    return this.#colors.length
  }

  indexOf(rgb: number): number {
    const known = this.#index.get(rgb)
    if (known !== undefined) return known
    let i: number
    if (this.#colors.length < 256) {
      i = this.#colors.length
      this.#colors.push(rgb)
    } else {
      let best = 1
      let bestD = Number.POSITIVE_INFINITY
      for (let j = 1; j < 256; j++) {
        const c = this.#colors[j]!
        const dr = ((c >> 16) & 255) - ((rgb >> 16) & 255)
        const dg = ((c >> 8) & 255) - ((rgb >> 8) & 255)
        const db = (c & 255) - (rgb & 255)
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) {
          bestD = d
          best = j
        }
      }
      i = best
    }
    this.#index.set(rgb, i)
    return i
  }

  /** 256 RGB triplets, unused slots black. */
  table(): Uint8Array {
    const t = new Uint8Array(768)
    this.#colors.forEach((c, i) => {
      t[i * 3] = (c >> 16) & 255
      t[i * 3 + 1] = (c >> 8) & 255
      t[i * 3 + 2] = c & 255
    })
    return t
  }
}
