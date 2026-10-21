/** Which size step the pane is at, and the box of cells each part gets. Pure. */
import { RASTER_MAX, SIZE } from './tokens.ts'
import { rect, type Rect, type Size, type SizeStep } from './types.ts'

export type Regions = {
  step: SizeStep
  top: Size
  bottom: Size | null
  header: Rect
  graph: Rect | null
  tree: Rect | null
  chips: boolean
  spotlight: Rect | null
  timeline: Rect | null
  feed: Rect | null
}

/** As the pane shrinks: drop the timeline, then cut the spotlight to one line, then swap the graph for a tree, then one line. */
export function sizeStep(size: Size): SizeStep {
  const { columns, rows } = size
  if (rows < SIZE.summaryBelowRows || columns < SIZE.summaryBelowColumns) return 'summary'
  if (rows < SIZE.treeBelowRows || columns < SIZE.treeBelowColumns) return 'tree'
  if (rows < SIZE.compactBelowRows) return 'compactSpotlight'
  if (rows < SIZE.noTimelineBelowRows) return 'noTimeline'
  return 'full'
}

const HEADER_ROWS = 2
const CHIP_ROWS = 1

export function planRegions(size: Size, agents: number): Regions {
  const step = sizeStep(size)
  const columns = Math.max(1, Math.min(RASTER_MAX.columns, Math.floor(size.columns)))
  const rows = Math.max(1, Math.floor(size.rows))
  const none = { bottom: null, graph: null, tree: null, chips: false, spotlight: null, timeline: null, feed: null }
  if (step === 'summary') return { ...none, step, top: { columns, rows: 1 }, header: rect(0, 0, columns, 1) }
  if (step === 'tree') {
    const h = Math.min(RASTER_MAX.rows, rows)
    return { ...none, step, top: { columns, rows: h }, header: rect(0, 0, columns, 1), tree: rect(0, 1, columns, h - 1) }
  }
  const spotRows = step === 'compactSpotlight' ? 1 : SIZE.spotlightRows
  const timelineRows = step === 'full' ? Math.min(SIZE.timelineMaxRows, Math.max(1, agents)) + 1 : 0
  const fixed = HEADER_ROWS + CHIP_ROWS + spotRows + timelineRows
  const wanted = Math.max(SIZE.minGraphRows, Math.round(rows * SIZE.graphShare))
  const graphRows = Math.max(SIZE.minGraphRows, Math.min(wanted, rows - fixed - SIZE.minFeedRows))
  const feedRows = Math.max(0, rows - fixed - graphRows)
  const topRows = Math.min(RASTER_MAX.rows, HEADER_ROWS + graphRows)
  const bottomRows = Math.min(RASTER_MAX.rows, spotRows + timelineRows + feedRows)
  return {
    step,
    top: { columns, rows: topRows },
    bottom: { columns, rows: bottomRows },
    header: rect(0, 0, columns, HEADER_ROWS),
    graph: rect(0, HEADER_ROWS, columns, topRows - HEADER_ROWS),
    tree: null,
    chips: true,
    spotlight: rect(0, 0, columns, spotRows),
    timeline: timelineRows > 0 ? rect(0, spotRows, columns, timelineRows) : null,
    feed: feedRows > 0 ? rect(0, spotRows + timelineRows, columns, Math.min(feedRows, bottomRows - spotRows - timelineRows)) : null,
  }
}
