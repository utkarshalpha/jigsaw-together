/* Shared puzzle model. Loaded by the server (require) and the browser (script tag).
 * Board coordinates are virtual units shared by everyone; each client draws them
 * through its own pan/zoom, so different screen sizes stay in sync.
 *
 * A "group" is a set of pieces already locked together. Pieces inside a group are
 * always in their correct relative arrangement, so a group needs only a single
 * translation: piece world pos = (group.x + col * pieceW, group.y + row * pieceH). */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Puzzle = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Deterministic PRNG so every client cuts the identical piece shapes from one seed.
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }

  // Pick rows/cols that land near the requested count while matching image aspect,
  // so pieces stay close to square.
  function chooseGrid(targetPieces, imageW, imageH) {
    const aspect = imageW / imageH;
    let best = null;
    for (let rows = 2; rows <= 40; rows++) {
      const cols = Math.max(2, Math.round(rows * aspect));
      const count = rows * cols;
      const pieceAspect = (imageW / cols) / (imageH / rows);
      const score = Math.abs(count - targetPieces) / targetPieces
                  + Math.abs(Math.log(pieceAspect)) * 1.5;
      if (!best || score < best.score) best = { rows, cols, score };
    }
    return { rows: best.rows, cols: best.cols };
  }

  /* Edge tabs. Every interior edge is stored once and shared by both neighbours,
   * so the knob on one piece is exactly the socket on the other.
   *   hEdges[r][c] = edge between piece (r-1,c) and (r,c)   (horizontal line)
   *   vEdges[r][c] = edge between piece (r,c-1) and (r,c)   (vertical line)
   * Value: 0 = flat border, otherwise +1 / -1 for knob direction, plus jitter. */
  function buildEdges(rows, cols, seed) {
    const rnd = makeRng(seed);
    const mk = () => ({ dir: rnd() < 0.5 ? 1 : -1, j: (rnd() - 0.5) * 0.12, k: 0.9 + rnd() * 0.25 });
    const hEdges = [], vEdges = [];
    for (let r = 0; r <= rows; r++) {
      hEdges.push([]);
      for (let c = 0; c < cols; c++) hEdges[r].push(r === 0 || r === rows ? null : mk());
    }
    for (let r = 0; r < rows; r++) {
      vEdges.push([]);
      for (let c = 0; c <= cols; c++) vEdges[r].push(c === 0 || c === cols ? null : mk());
    }
    return { hEdges, vEdges };
  }

  // Union-find over groups, used when merging locked pieces.
  function findRoot(groups, id) {
    let g = groups[id];
    while (g.parent !== null) g = groups[g.parent];
    return g;
  }

  /* Given a dropped group, find every neighbouring group that is now within
   * `tol` of its correct relative position and merge them all in.
   * Runs identically on server and client. Returns the list of merged group ids. */
  function resolveSnaps(state, groupId, tol) {
    const { pieces, groups, pieceW, pieceH } = state;
    const merged = [];
    let changed = true;
    while (changed) {
      changed = false;
      const g = findRoot(groups, groupId);
      for (const pid of g.pieces) {
        const p = pieces[pid];
        const neighbours = [
          [p.row - 1, p.col], [p.row + 1, p.col],
          [p.row, p.col - 1], [p.row, p.col + 1]
        ];
        for (const [nr, nc] of neighbours) {
          if (nr < 0 || nc < 0 || nr >= state.rows || nc >= state.cols) continue;
          const np = pieces[nr * state.cols + nc];
          const ng = findRoot(groups, np.group);
          if (ng.id === g.id) continue;
          if (Math.abs(ng.x - g.x) <= tol && Math.abs(ng.y - g.y) <= tol) {
            // Absorb the smaller group into the larger so big assemblies stay put.
            const [keep, gone] = g.pieces.length >= ng.pieces.length ? [g, ng] : [ng, g];
            for (const q of gone.pieces) { pieces[q].group = keep.id; keep.pieces.push(q); }
            gone.pieces = [];
            gone.parent = keep.id;
            merged.push(gone.id);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
    return merged;
  }

  function isSolved(state) {
    for (const g of Object.values(state.groups)) {
      if (g.parent === null && g.pieces.length === state.rows * state.cols) return true;
    }
    return false;
  }

  return { makeRng, chooseGrid, buildEdges, findRoot, resolveSnaps, isSolved };
});
