import { GridLayout } from './view';

/** Keep domain geometry intact; project its 84rpx rows into readable physical rows. */
export function presentGrid(grid: GridLayout, expanded = false) {
  const sectionHeightPx = 44;
  let last = 0;
  for (const column of grid.columns) for (const block of column.blocks) last = Math.max(last, block.end);
  const compactCount = Math.min(12, Math.max(6, Math.ceil(last / 2) * 2));
  const sectionNumbers = grid.sectionNumbers.slice(0, expanded ? 12 : compactCount);
  const sectionPairs: { label: string; heightPx: number }[] = [];
  for (let index = 0; index < sectionNumbers.length; index += 2) {
    sectionPairs.push({ label: `${sectionNumbers[index]}–${sectionNumbers[index + 1]}`, heightPx: sectionHeightPx * 2 });
  }
  return {
    columns: grid.columns.map(column => ({ ...column, blocks: column.blocks.map(block => ({
      ...block, topPx: block.topRpx * sectionHeightPx / 84, heightPx: block.heightRpx * sectionHeightPx / 84,
    })) })),
    widthPx: 7 * 66,
    heightPx: sectionNumbers.length * sectionHeightPx,
    totalHeightPx: sectionNumbers.length * sectionHeightPx + 30,
    sectionNumbers,
    sectionPairs,
    canCollapse: compactCount < 12,
    hiddenFrom: sectionNumbers.length < 12 ? sectionNumbers.length + 1 : 0,
  };
}
