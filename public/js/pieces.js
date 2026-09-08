/* Cuts the picture into interlocking jigsaw pieces.
 *
 * Each piece is rendered once into its own small canvas (image + bevel), then the
 * game loop only ever blits those canvases. That keeps 500-piece boards smooth.
 *
 * A piece's local coordinate space puts its rectangular body at (M, M) with a
 * margin M all around for the knobs to stick out into. */

const Pieces = (() => {

  // Normalised jigsaw edge, travelling left to right along a unit edge.
  // y is perpendicular; d flips the knob to the other side. The control points
  // that sit outside the neck (0.30 / 0.70) are what create the undercut, which
  // is what makes pieces actually look interlocked rather than wavy.
  const TAB = [
    [0.20, 0.00, 0.33, 0.05, 0.40, 0.05],
    [0.30, 0.14, 0.30, 0.30, 0.50, 0.30],
    [0.70, 0.30, 0.70, 0.14, 0.60, 0.05],
    [0.67, 0.05, 0.80, 0.00, 1.00, 0.00]
  ];

  /* Append one edge from a to b. `e` is the shared edge descriptor (null = flat
   * border). `flip` is set when we traverse the edge backwards, so the knob
   * still points the same way in world space for both neighbours. */
  function edge(path, ax, ay, bx, by, e, flip, nScale) {
    if (!e) { path.lineTo(bx, by); return; }
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;       // along the edge
    const px = -uy, py = ux;              // perpendicular
    const d = e.dir * (flip ? -1 : 1) * 0.78 * e.k;
    const j = flip ? -e.j : e.j;          // nudge the knob along the edge

    const at = (t, n) => {
      const tt = t + (t > 0.05 && t < 0.95 ? j : 0);
      return [ax + ux * tt * L + px * n * d * nScale,
              ay + uy * tt * L + py * n * d * nScale];
    };

    for (const [c1t, c1n, c2t, c2n, et, en] of TAB) {
      const [x1, y1] = at(c1t, c1n);
      const [x2, y2] = at(c2t, c2n);
      const [x3, y3] = at(et, en);
      path.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    }
  }

  /* Outline of piece (r,c) in its own local space. */
  function piecePath(r, c, geo) {
    const { pieceW, pieceH, margin: M, hEdges, vEdges, nScale } = geo;
    const p = new Path2D();
    const x0 = M, y0 = M, x1 = M + pieceW, y1 = M + pieceH;
    p.moveTo(x0, y0);
    edge(p, x0, y0, x1, y0, hEdges[r][c],       false, nScale); // top, left to right
    edge(p, x1, y0, x1, y1, vEdges[r][c + 1],   false, nScale); // right, top to bottom
    edge(p, x1, y1, x0, y1, hEdges[r + 1][c],   true,  nScale); // bottom, reversed
    edge(p, x0, y1, x0, y0, vEdges[r][c],       true,  nScale); // left, reversed
    p.closePath();
    return p;
  }

  /* Build every piece's path and pre-rendered canvas. */
  function build(img, puzzle) {
    const { rows, cols, pieceW, pieceH, puzzleW, puzzleH, seed } = puzzle;
    const { hEdges, vEdges } = Puzzle.buildEdges(rows, cols, seed);
    const short = Math.min(pieceW, pieceH);
    const geo = {
      pieceW, pieceH, hEdges, vEdges,
      nScale: short,
      // Room for the knobs (~0.27) plus the baked shadow's offset and blur.
      margin: short * 0.42
    };
    const M = geo.margin;

    // Render at the picture's own detail level, capped so big boards stay light.
    const res = Math.max(1, Math.min(2.2, (img.naturalWidth || img.width) / puzzleW));

    const list = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const path = piecePath(r, c, geo);
        const cw = pieceW + M * 2, ch = pieceH + M * 2;
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(cw * res);
        cv.height = Math.ceil(ch * res);
        const g = cv.getContext('2d');
        g.scale(res, res);

        /* Cast the piece's shadow onto the table first, baked into this canvas.
         * Doing it here costs one fill at load; doing it per frame would mean a
         * blur on every piece on every frame. Fills the path with the shadow
         * turned on, then the artwork is drawn over the top. */
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.45)';
        g.shadowBlur = Math.max(2, short * 0.05);
        g.shadowOffsetX = short * 0.018;
        g.shadowOffsetY = short * 0.028;
        g.fillStyle = '#000';
        g.fill(path);
        g.restore();

        g.save();
        g.clip(path);
        // Place the whole picture so this piece's slice lands under its body.
        g.drawImage(img, M - c * pieceW, M - r * pieceH, puzzleW, puzzleH);
        // Inner shading, drawn while still clipped so it hugs the outline.
        g.lineJoin = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.38)';
        g.lineWidth = 2.6;
        g.translate(1.1, 1.3); g.stroke(path); g.translate(-1.1, -1.3);
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 2.2;
        g.translate(-1.1, -1.3); g.stroke(path); g.translate(1.1, 1.3);
        g.restore();

        // Crisp outline on top of everything.
        g.strokeStyle = 'rgba(0,0,0,0.5)';
        g.lineWidth = 0.9;
        g.stroke(path);

        list.push({ id: r * cols + c, row: r, col: c, path, canvas: cv, w: cw, h: ch });
      }
    }
    return { pieces: list, margin: M, geo };
  }

  return { build, piecePath };
})();
