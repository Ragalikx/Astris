// Placeholder pixel icons: 8×8 bitmaps drawn as crisp SVG squares in the current colour.
// `<i data-icon="name"></i>` becomes the icon (fillIcons), or `icon(name)` makes one.
const BITMAPS = {
  play: '.#......|.##.....|.###....|.####...|.####...|.###....|.##.....|.#......',
  gear: '...##...|.######.|.##..##.|###..###|###..###|.##..##.|.######.|...##...',
  heart: '........|.##.##..|#######.|#######.|.#####..|..###...|...#....|........',
  star: '...#....|...#....|..###...|#######.|..###...|...#....|...#....|........',
  user: '..####..|..####..|..####..|...##...|.######.|########|########|........',
  globe: '..####..|.#.##.#.|#..##..#|########|#..##..#|.#.##.#.|..####..|........',
  doc: '######..|#....##.|#.##..#.|#.....#.|#.###.#.|#.....#.|#######.|........',
  box: '..####..|.#....#.|########|#..##..#|#......#|#......#|########|........',
  chevron: '........|........|#.....#.|.#...#..|..#.#...|...#....|........|........',
  lock: '..###...|.#...#..|.#...#..|#######.|###.###.|###.###.|#######.|........',
  close: '#.....#.|.#...#..|..#.#...|...#....|..#.#...|.#...#..|#.....#.|........',
  check: '........|......#.|.....#..|#...#...|.#.#....|..#.....|........|........',
  download: '...#....|...#....|...#....|.#####..|..###...|...#....|#######.|........',
  warn: '...#....|..###...|..#.#...|.##.##..|.#####..|##.#.##.|#######.|........',
  bolt: '....##..|...##...|..##....|.######.|....##..|...##...|..##....|.##.....',
  folder: '........|###.....|#######.|#.....#.|#.....#.|#.....#.|#######.|........',
  cube: '..####..|.#....#.|######.#|#....#.#|#....#.#|#....##.|######..|........',
};

// The GitHub mark (Octicons, MIT).
const GITHUB = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

const NS = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  if (name === 'github') {
    svg.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', GITHUB);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const rows = (BITMAPS[name] ?? BITMAPS.cube).split('|');
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

export function fillIcons(root = document) {
  for (const node of root.querySelectorAll('i[data-icon]')) node.replaceWith(icon(node.dataset.icon));
}
