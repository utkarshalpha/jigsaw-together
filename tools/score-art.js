/* Score a painting for how solvable it is as a jigsaw.
 *
 * A piece is only placeable if it carries detail. Big flat regions - fog, open
 * sky, smooth water - produce pieces that look identical to a dozen others, and
 * those are the pieces that make a puzzle miserable. So: cut the image into the
 * same grid the game would, measure the local contrast of each cell, and count
 * how many cells are too bland to identify.
 *
 * Usage: node score-art.js            (scores the shipped gallery)
 *        node score-art.js <url...>   (scores candidates) */
const jpeg = require('jpeg-js');
const fs = require('fs');

const GRID_COLS = 10, GRID_ROWS = 8;      // close to the real 80-piece cut
const BLAND = 14;                          // stdev below this = featureless

async function fetchBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'jigsaw-together/1.0 (gallery QA)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function score(raw) {
  const img = jpeg.decode(raw, { useTArray: true });
  const { width: W, height: H, data } = img;
  const lum = new Float64Array(W * H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const cw = Math.floor(W / GRID_COLS), ch = Math.floor(H / GRID_ROWS);
  const cells = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      let sum = 0, sum2 = 0, n = 0;
      for (let y = r * ch; y < (r + 1) * ch; y++) {
        for (let x = c * cw; x < (c + 1) * cw; x++) {
          const v = lum[y * W + x];
          sum += v; sum2 += v * v; n++;
        }
      }
      const mean = sum / n;
      cells.push(Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
    }
  }

  cells.sort((a, b) => a - b);
  const bland = cells.filter((s) => s < BLAND).length;
  const worst = cells[0];
  const median = cells[Math.floor(cells.length / 2)];
  // Worst decile matters most: those are the pieces you get stuck on.
  const p10 = cells[Math.floor(cells.length * 0.1)];
  return {
    cells: cells.length,
    blandCells: bland,
    blandPct: Math.round((bland / cells.length) * 100),
    worst: +worst.toFixed(1),
    p10: +p10.toFixed(1),
    median: +median.toFixed(1)
  };
}

const verdict = (s) =>
  s.blandPct >= 20 || s.p10 < 10 ? 'REJECT'
    : s.blandPct >= 10 || s.p10 < 14 ? 'weak'
      : 'good';

(async () => {
  let items;
  if (process.argv.length > 2) {
    items = process.argv.slice(2).map((u, i) => ({ title: 'candidate ' + (i + 1), url: u }));
  } else {
    const src = fs.readFileSync(__dirname + '/../public/js/gallery.js', 'utf8');
    items = [...src.matchAll(/title:\s*"([^"]+)"[\s\S]*?dataUrl:\s*"([^"]+)"/g)]
      .map((m) => ({ title: m[1], url: m[2] }));
  }

  console.log(`scoring ${items.length} paintings (${GRID_COLS}x${GRID_ROWS} cells, bland = stdev < ${BLAND})\n`);
  console.log('verdict  bland%  worst   p10  median  painting');
  console.log('-------  ------  -----  ----  ------  --------');
  const out = [];
  for (const it of items) {
    try {
      const s = score(await fetchBytes(it.url));
      const v = verdict(s);
      out.push({ ...it, ...s, verdict: v });
      console.log(
        `${v.padEnd(7)}  ${String(s.blandPct).padStart(5)}%  ${String(s.worst).padStart(5)}  ` +
        `${String(s.p10).padStart(4)}  ${String(s.median).padStart(6)}  ${it.title}`
      );
    } catch (e) {
      console.log(`ERROR    ${' '.repeat(24)}${it.title}: ${e.message}`);
    }
  }
  fs.writeFileSync(__dirname + '/art-scores.json', JSON.stringify(out, null, 2));
  const bad = out.filter((o) => o.verdict !== 'good');
  console.log(`\n${out.filter(o => o.verdict === 'good').length} good, ${bad.length} to reconsider: ${bad.map(b => b.title).join(', ') || 'none'}`);
})();
