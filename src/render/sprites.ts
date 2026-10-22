/**
 * The robot node style's tokens and skins (pane.md section 12). Every robot pixel comes from ROBOT_SKINS; the rules in
 * robot.ts are written against the skin contract, never one skin's shape. A new skin is one new entry. Pure and mod-safe.
 */

export type RobotSize = 'S' | 'M' | 'L'
export const ROBOT_SIZES: readonly RobotSize[] = ['S', 'M', 'L']

/**
 * Shared by every skin (pane.md 12.2, 12.3, 12.5). `size`: the radius each size starts at, hop headroom, the halo's
 * radius range and the sprite limit, and the hop lift per slot of the glow period.
 */
export const ROBOT = {
  skin: 'clawd',
  dead: 0x2a2e36,
  size: {
    S: { fromR: 0, headroom: 1, rLo: 1.6, rHi: 2.8, maxW: 8, maxH: 5, hop: [0, 0, 0, 0, 0, 0, 0, 1, 1, 0] },
    M: { fromR: 2.8, headroom: 2, rLo: 2.8, rHi: 4.0, maxW: 11, maxH: 6, hop: [0, 0, 0, 0, 0, 0, 1, 2, 2, 1] },
    L: { fromR: 4.0, headroom: 2, rLo: 4.0, rHi: 6.0, maxW: 13, maxH: 7, hop: [0, 0, 0, 0, 0, 0, 1, 2, 2, 1] },
  },
  waitingTone: 0.72,
  failedGlowK: 0.7,
  outlineK: 0.9,
  blinkMs: 6000,
  blinkClosedMs: 200,
} as const

export type Eyes = 'open' | 'closed' | 'cross'
export type Arms = 'down' | 'up'

/**
 * One size of a skin. Bitmap letters: `.` clear, `B` body, `E` eye, `A` arm, `L` leg; `D` and `H` are the allowed
 * shades of the body. `body` is the trunk rectangle [x0, y0, x1, y1]; `haloRows` the last sprite row the halo paints.
 */
export type SkinSprite = {
  w: number
  h: number
  body: readonly [number, number, number, number]
  haloRows: number
  eyes: { open: readonly string[]; closed: readonly string[]; cross?: readonly string[] }
  arms: { down: readonly string[]; up: readonly string[] }
  /** The warned sweat-drop pixels (pane.md 13.2); the nudged copy is mirrored, x to w - 1 - x. */
  sweat: readonly (readonly [number, number])[]
}
export type Skin = { bodyColor: number; sprites: Readonly<Record<RobotSize, SkinSprite>> }

const CLAWD_S_OPEN = ['.BBBBBB.', '.BEBBEB.', 'ABBBBBBA', '.BBBBBB.', '..L..L..']
const CLAWD_M_OPEN = ['.BBBBBBBBB.', '.BBEBBBEBB.', '.BBEBBBEBB.', 'ABBBBBBBBBA', '.BBBBBBBBB.', '.L.L...L.L.']
const CLAWD_L_OPEN = ['.BBBBBBBBBBB.', '.BBEBBBBBEBB.', '.BBEBBBBBEBB.', 'ABBBBBBBBBBBA', 'ABBBBBBBBBBBA', '.BBBBBBBBBBB.', '..L.L...L.L..']

export const ROBOT_SKINS: Readonly<Record<string, Skin>> = {
  /** After the Claude Code mascot; a placeholder likeness until an original skin replaces it. */
  clawd: {
    bodyColor: 0xd77757,
    sprites: {
      S: {
        w: 8, h: 5, body: [1, 0, 6, 3], haloRows: 3, sweat: [[7, 0], [7, 1]],
        eyes: { open: CLAWD_S_OPEN, closed: ['.BBBBBB.', '.BBBBBB.', 'ABBBBBBA', '.BBBBBB.', '..L..L..'] },
        arms: { down: CLAWD_S_OPEN, up: ['.BBBBBB.', 'ABEBBEBA', '.BBBBBB.', '.BBBBBB.', '..L..L..'] },
      },
      M: {
        w: 11, h: 6, body: [1, 0, 9, 4], haloRows: 4, sweat: [[9, 0], [8, 1], [9, 1]],
        eyes: {
          open: CLAWD_M_OPEN,
          closed: ['.BBBBBBBBB.', '.BBBBBBBBB.', '.BEEEBEEEB.', 'ABBBBBBBBBA', '.BBBBBBBBB.', '.L.L...L.L.'],
          cross: ['.BBBBBBBBB.', '.BEBBBBBEB.', '.BBEBBBEBB.', 'ABEBBBBBEBA', '.BBBBBBBBB.', '.L.L...L.L.'],
        },
        arms: { down: CLAWD_M_OPEN, up: ['ABBBBBBBBBA', 'ABBEBBBEBBA', '.BBEBBBEBB.', '.BBBBBBBBB.', '.BBBBBBBBB.', '.L.L...L.L.'] },
      },
      L: {
        w: 13, h: 7, body: [1, 0, 11, 5], haloRows: 5, sweat: [[11, 0], [10, 1], [11, 1], [10, 2], [11, 2]],
        eyes: {
          open: CLAWD_L_OPEN,
          closed: ['.BBBBBBBBBBB.', '.BBBBBBBBBBB.', '.BEEEBBBEEEB.', 'ABBBBBBBBBBBA', 'ABBBBBBBBBBBA', '.BBBBBBBBBBB.', '..L.L...L.L..'],
          cross: ['.BBBBBBBBBBB.', '.BEBEBBBEBEB.', '.BBEBBBBBEBB.', 'ABEBEBBBEBEBA', 'ABBBBBBBBBBBA', '.BBBBBBBBBBB.', '..L.L...L.L..'],
        },
        arms: {
          down: CLAWD_L_OPEN,
          up: ['ABBBBBBBBBBBA', 'ABBEBBBBBEBBA', '.BBEBBBBBEBB.', '.BBBBBBBBBBB.', '.BBBBBBBBBBB.', '.BBBBBBBBBBB.', '..L.L...L.L..'],
        },
      },
    },
  },
}

export const activeSkin = (): Skin => ROBOT_SKINS[ROBOT.skin]!

const composed = new WeakMap<SkinSprite, Map<string, readonly string[]>>()

/**
 * The sprite for an eye and arm state (pane.md 12.4, compositing): the eye variant with its `A` cells cleared, then
 * `A` wherever the arm variant has one. A skin with no `eyes.cross` uses its open eyes for it. Cached per sprite.
 */
export function composite(s: SkinSprite, eyes: Eyes, arms: Arms): readonly string[] {
  let known = composed.get(s)
  if (known === undefined) composed.set(s, (known = new Map()))
  const key = `${eyes} ${arms}`
  const hit = known.get(key)
  if (hit !== undefined) return hit
  const base = eyes === 'closed' ? s.eyes.closed : eyes === 'cross' ? (s.eyes.cross ?? s.eyes.open) : s.eyes.open
  const armRows = arms === 'up' ? s.arms.up : s.arms.down
  const out = base.map((row, y) => [...row].map((ch, x) => (armRows[y]?.[x] === 'A' ? 'A' : ch === 'A' ? '.' : ch)).join(''))
  known.set(key, out)
  return out
}
