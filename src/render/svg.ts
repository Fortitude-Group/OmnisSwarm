/**
 * The same Grid as an SVG document, for surfaces that draw vectors instead of a Raster (the desktop app). Block and
 * braille glyphs become rectangles so they line up whatever the font; other glyphs are placed cell by cell. Pure.
 */
import { DEFAULT, hex } from './color.ts'
import type { Grid } from './grid.ts'

/** The host's limit on an Svg element's source; past it the whole tree would be refused. */
export const SVG_SOURCE_MAX = 131_072
export const CELL_W = 8
export const CELL_H = 16
/** The terminal's own foreground has no value off the terminal: a grey that reads on light and dark pages. */
const DEFAULT_FG = '#8b949e'
const FONT = 'font-family="SFMono-Regular, Menlo, Consolas, DejaVu Sans Mono, monospace" font-size="13"'
/** Braille dot bit to [column, row] in the 2x4 cell. */
const DOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

/** A block glyph as fractions of a cell [x, y, w, h] and an opacity, or null for any other glyph. */
export function blockShape(cp: number): readonly [number, number, number, number, number] | null {
  if (cp === 0x2580) return [0, 0, 1, 0.5, 1]
  if (cp >= 0x2581 && cp <= 0x2588) {
    const n = cp - 0x2580
    return [0, 1 - n / 8, 1, n / 8, 1]
  }
  if (cp >= 0x2589 && cp <= 0x258f) return [0, 0, (0x2590 - cp) / 8, 1, 1]
  if (cp === 0x2590) return [0.5, 0, 0.5, 1, 1]
  if (cp >= 0x2591 && cp <= 0x2593) return [0, 0, 1, 1, (cp - 0x2590) / 4]
  return null
}

/** Escapes text for an element body or attribute, dropping code points XML 1.0 cannot hold. */
export function escapeXml(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0xd800 && c <= 0xdfff) || c === 0xfffe || c === 0xffff) continue
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&apos;' : ch
  }
  return out
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))

/** Rectangles grouped by fill and opacity: one path per colour, not one element per cell. */
class Fills {
  readonly #paths = new Map<string, string[]>()

  rect(fill: string, opacity: number, x: number, y: number, w: number, h: number): void {
    const key = opacity === 1 ? fill : `${fill}|${num(opacity)}`
    const d = `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`
    const list = this.#paths.get(key)
    if (list === undefined) this.#paths.set(key, [d])
    else list.push(d)
  }

  toSvg(): string {
    return [...this.#paths].map(([key, list]) => {
      const [fill, opacity] = key.split('|')
      return `<path fill="${fill}"${opacity === undefined ? '' : ` fill-opacity="${opacity}"`} d="${list.join('')}"/>`
    }).join('')
  }
}

export function gridToSvg(grid: Grid, alt: string, max = SVG_SOURCE_MAX): string | null {
  const back = new Fills()
  const fore = new Fills()
  const texts: string[] = []
  let size = 0
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.columns;) {
      const bg = grid.bg(x, y)
      let end = x + 1
      while (end < grid.columns && grid.bg(end, y) === bg) end++
      if (bg !== DEFAULT) {
        back.rect(hex(bg), 1, x * CELL_W, y * CELL_H, (end - x) * CELL_W, CELL_H)
        size += 28
      }
      x = end
    }
    let run: { fg: string; xs: number[]; text: string } | null = null
    const flush = (): void => {
      if (run === null) return
      const el = `<text ${FONT} fill="${run.fg}" x="${run.xs.join(' ')}" y="${y * CELL_H + 12}" xml:space="preserve">${run.text}</text>`
      texts.push(el)
      size += el.length
      run = null
    }
    for (let x = 0; x < grid.columns; x++) {
      const code = grid.glyph(x, y)
      const fgRaw = grid.fg(x, y)
      const fg = fgRaw === DEFAULT ? DEFAULT_FG : hex(fgRaw)
      const shape = blockShape(code)
      if (shape !== null) {
        flush()
        const [sx, sy, sw, sh, opacity] = shape
        fore.rect(fg, opacity, (x + sx) * CELL_W, (y + sy) * CELL_H, sw * CELL_W, sh * CELL_H)
        size += 28
      } else if (code > 0x2800 && code <= 0x28ff) {
        flush()
        for (let bit = 0; bit < 8; bit++) {
          if (((code - 0x2800) >> bit) & 1) {
            const [col, row] = DOTS[bit]!
            fore.rect(fg, 1, x * CELL_W + col * 4 + 1, y * CELL_H + row * 4 + 1, 2, 2)
            size += 20
          }
        }
      } else if (code === 0x20 || code === 0x2800) {
        flush()
      } else {
        const glyph = escapeXml(String.fromCodePoint(code))
        if (glyph === '') flush()
        else if (run !== null && run.fg === fg) {
          run.text += glyph
          run.xs.push(x * CELL_W)
        } else {
          flush()
          run = { fg, xs: [x * CELL_W], text: glyph }
        }
      }
      if (size > max) return null
    }
    flush()
  }
  const width = grid.columns * CELL_W
  const height = grid.rows * CELL_H
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escapeXml(alt)}</title>${back.toSvg()}${fore.toSvg()}${texts.join('')}</svg>`
  return svg.length > max ? null : svg
}
