/* Jigsaw Together - client.
 *
 * Everything on the board lives in shared "board units". Each player renders
 * those through their own pan/zoom, so a phone and a 4K monitor see the same
 * puzzle at whatever size suits them, and cursors still land in the right spot. */

(() => {
  const $ = (id) => document.getElementById(id);

  /* Fail loudly and specifically rather than showing a blank board. Everything
   * here is genuinely required to draw or sync the puzzle; mic and camera are
   * checked separately because the game is perfectly playable without them. */
  const REQUIRED = [
    ['WebSocket', () => typeof WebSocket !== 'undefined', 'real-time updates'],
    ['Canvas 2D', () => !!document.createElement('canvas').getContext, 'drawing the board'],
    ['Path2D', () => typeof Path2D !== 'undefined', 'cutting jigsaw shapes'],
    ['Pointer events', () => typeof PointerEvent !== 'undefined', 'dragging pieces'],
    ['CSS variables', () => window.CSS && CSS.supports && CSS.supports('color', 'var(--x)'), 'the whole layout']
  ];
  const missing = REQUIRED.filter(([, test]) => { try { return !test(); } catch { return true; } });
  if (missing.length) {
    $('unsupportedWhy').textContent =
      'Missing: ' + missing.map(([n, , why]) => `${n} (needed for ${why})`).join(', ') + '.';
    $('unsupported').hidden = false;
    $('lobby').hidden = true;
    return;
  }

  // Presence colours, picked to read clearly on the dark table and against art.
  const COLORS = ['#5865f2', '#23a55a', '#f0b132', '#f23f43', '#eb459f',
    '#00a8fc', '#f47b67', '#9b59f6', '#1abc9c', '#e67e22'];

  // One sensible board, no dial to fiddle with. 48 felt thin and 126 felt like a
  // chore; this lands every painting shape in the 70-84 range.
  const DEFAULT_PIECES = 80;
  // The server decides snapping and ships its tolerance with the board; this
  // is only a fallback for the moment before a puzzle has loaded.
  const snapTol = () => (S.puzzle && S.puzzle.snapTol) || 40;
  const MOVE_HZ = 1000 / 33;
  const CURSOR_HZ = 1000 / 25;

  const S = {
    me: null,
    hostId: null,
    code: null,
    players: new Map(),
    placed: new Map(),               // playerId -> pieces they locked in
    media: new Map(),                // playerId -> { audio, video }
    puzzle: null,
    groups: {},
    pieces: [],                      // from Pieces.build, indexed by piece id
    margin: 0,
    img: null,
    ready: false,
    view: { x: 0, y: 0, scale: 1 },
    drag: null,
    pan: null,
    pointers: new Map(),
    pinch: null,
    preview: false,
    peekers: new Set(),              // players currently holding peek
    startedAt: null,
    solvedAt: null,
    lastMoveSent: 0,
    lastCursorSent: 0,
    pendingSetup: null
  };

  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const hit = document.createElement('canvas').getContext('2d'); // path hit tests only

  // ===================================================================
  // geometry helpers
  // ===================================================================
  const toBoard = (sx, sy) => ({
    x: (sx - S.view.x) / S.view.scale,
    y: (sy - S.view.y) / S.view.scale
  });
  const toScreen = (bx, by) => ({
    x: bx * S.view.scale + S.view.x,
    y: by * S.view.scale + S.view.y
  });
  // Pointer position relative to the canvas (which sits below the top bar).
  const evPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const root = (id) => {
    let g = S.groups[id];
    while (g && g.parent !== null) g = S.groups[g.parent];
    return g;
  };
  const rootGroups = () => Object.values(S.groups).filter((g) => g.parent === null);

  // ===================================================================
  // background felt
  // ===================================================================
  /* The mat the pieces sit on. Its colour comes from the same CSS token the
   * rest of the page uses, so switching theme moves the board with it, and the
   * grain keeps a flat fill from looking like dead pixels. */
  const themeVar = (n, fallback) =>
    (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || fallback;

  let felt = null, feltPattern = null;

  function buildFelt() {
    const base = themeVar('--felt-a', '#e7e5e0');
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      const v = Math.random();
      g.fillStyle = `rgba(${v < .5 ? '255,255,255' : '0,0,0'},${0.012 + Math.random() * 0.03})`;
      g.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
    }
    felt = c;
    feltPattern = null;                 // rebuilt on the next resize()
  }
  buildFelt();

  // Guides drawn on the board have to flip with the theme or they vanish.
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const guide = () => (isDark()
    ? { well: 'rgba(0,0,0,0.22)', line: 'rgba(255,255,255,0.20)' }
    : { well: 'rgba(33,32,28,0.055)', line: 'rgba(33,32,28,0.22)' });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;              // still hidden; never pin the buffer at 0
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!feltPattern) feltPattern = ctx.createPattern(felt, 'repeat');
  }
  window.addEventListener('resize', resize);

  /* Fit the board into whatever the panel isn't covering. The panel is a right
   * sidebar on desktop and a bottom sheet on phones, so measure where it
   * actually is rather than assuming. */
  function panelInset() {
    const side = $('side');
    if (side.classList.contains('hidden')) return { right: 0, bottom: 0 };
    const r = side.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { right: 0, bottom: 0 };
    // Whichever edge it hugs is the one we keep clear of.
    if (r.left >= cr.left + cr.width * 0.5) return { right: Math.max(0, cr.right - r.left), bottom: 0 };
    if (r.top >= cr.top + cr.height * 0.5) return { right: 0, bottom: Math.max(0, cr.bottom - r.top) };
    return { right: 0, bottom: 0 };
  }

  function fitView() {
    if (!S.puzzle) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const pad = 14;
    const ins = panelInset();
    const availW = Math.max(120, w - pad * 2 - ins.right);
    const availH = Math.max(120, h - pad * 2 - ins.bottom);

    /* Containing the whole board is right on a wide screen. On a tall phone the
     * board is wider than it is tall, so containing it leaves most of the
     * screen empty and shrinks every piece. Fill more of the short side there
     * and let the player pan - a piece you can actually grab beats seeing the
     * entire tray at once. */
    const contain = Math.min(availW / S.puzzle.boardW, availH / S.puzzle.boardH);
    const cover = Math.max(availW / S.puzzle.boardW, availH / S.puzzle.boardH);
    const tall = availH / availW > 1.25;
    const s = tall ? Math.min(cover, contain * 1.8) : contain;

    S.view.scale = Math.max(0.05, s);
    S.view.x = pad + (availW - S.puzzle.boardW * S.view.scale) / 2;
    S.view.y = pad + (availH - S.puzzle.boardH * S.view.scale) / 2;
  }

  // ===================================================================
  // render loop
  // ===================================================================
  function draw() {
    requestAnimationFrame(draw);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;

    ctx.save();
    ctx.fillStyle = feltPattern || themeVar('--felt-a', '#e7e5e0');
    ctx.save();
    // Keep the felt grain anchored to the board so panning feels physical.
    ctx.translate(S.view.x % 128, S.view.y % 128);
    ctx.fillRect(-128, -128, w + 256, h + 256);
    ctx.restore();

    if (!S.ready || !S.puzzle) { ctx.restore(); return; }

    const P = S.puzzle;
    ctx.translate(S.view.x, S.view.y);
    ctx.scale(S.view.scale, S.view.scale);

    // Where the finished picture belongs: a shallow well in the mat.
    const gu = guide();
    ctx.fillStyle = gu.well;
    ctx.fillRect(P.originX, P.originY, P.puzzleW, P.puzzleH);
    // Fully opaque: a faint ghost is hard to read on a busy painting, and peek
    // is a deliberate hold - you asked to see it, so show it properly. Pieces
    // still draw on top, so you can see exactly what is already placed.
    if (anyonePeeking() && S.img) {
      ctx.drawImage(S.img, P.originX, P.originY, P.puzzleW, P.puzzleH);
    }
    ctx.strokeStyle = gu.line;
    ctx.lineWidth = 2 / S.view.scale;
    ctx.setLineDash([10 / S.view.scale, 8 / S.view.scale]);
    ctx.strokeRect(P.originX, P.originY, P.puzzleW, P.puzzleH);
    ctx.setLineDash([]);

    // Cull to what's actually on screen - matters at 600 pieces.
    const tl = toBoard(0, 0), br = toBoard(w, h);
    const M = S.margin;
    const groups = rootGroups().sort((a, b) => a.z - b.z);

    for (const g of groups) {
      // A held piece reads as "lifted off the table" via a plain drop shadow,
      // and is claimed by an outline in its holder's colour - including your
      // own, so the colour you picked is the one you see under your hand.
      if (g.heldBy) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 16 / S.view.scale;
        ctx.shadowOffsetX = 5 / S.view.scale;
        ctx.shadowOffsetY = 7 / S.view.scale;
      }
      for (const pid of g.pieces) {
        const piece = S.pieces[pid];
        if (!piece) continue;
        const wx = g.x + piece.col * P.pieceW - M;
        const wy = g.y + piece.row * P.pieceH - M;
        if (wx > br.x || wy > br.y || wx + piece.w < tl.x || wy + piece.h < tl.y) continue;
        ctx.drawImage(piece.canvas, wx, wy, piece.w, piece.h);
      }
      ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;

      // Outline whatever anyone is holding, in that player's colour.
      if (g.heldBy) {
        const p = S.players.get(g.heldBy);
        if (p) {
          const mine = g.heldBy === S.me.id;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = (mine ? 3.2 : 2.5) / S.view.scale;
          for (const pid of g.pieces) {
            const piece = S.pieces[pid];
            if (!piece) continue;
            ctx.save();
            ctx.translate(g.x + piece.col * P.pieceW - M, g.y + piece.row * P.pieceH - M);
            ctx.stroke(piece.path);
            ctx.restore();
          }
        }
      }
    }

    /* Show where a held group will lock, so "these two clearly go together"
     * and "the game agrees" are the same thing. */
    const hint = snapPreview();
    if (hint) {
      const g = S.groups[S.drag.id];
      const me = S.players.get(S.me.id);
      ctx.save();
      ctx.strokeStyle = me ? me.color : '#5865f2';
      ctx.lineWidth = 3 / S.view.scale;
      ctx.setLineDash([9 / S.view.scale, 6 / S.view.scale]);
      ctx.globalAlpha = 0.95;
      for (const pid of g.pieces) {
        const piece = S.pieces[pid];
        if (!piece) continue;
        ctx.save();
        ctx.translate(hint.x + piece.col * P.pieceW - M, hint.y + piece.row * P.pieceH - M);
        ctx.stroke(piece.path);
        ctx.restore();
      }
      ctx.restore();
    }

    ctx.restore();

    paintCursors();
  }

  /* Where would the held group land if released right now? Returns the snapped
   * translation when a correct neighbour is within reach, else null. Purely a
   * preview - the server still decides. */
  function snapPreview() {
    if (!S.drag || !S.puzzle) return null;
    const g = S.groups[S.drag.id];
    if (!g) return null;
    const P = S.puzzle, tol = snapTol();
    let best = null, bestD = Infinity;
    for (const pid of g.pieces) {
      const r = Math.floor(pid / P.cols), c = pid % P.cols;
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nc < 0 || nr >= P.rows || nc >= P.cols) continue;
        const ng = S.groups[nr * P.cols + nc];
        const nroot = ng && (ng.parent === null ? ng : S.groups[ng.parent]);
        if (!nroot || nroot === g || nroot.pieces.length === 0) continue;
        const dx = nroot.x - g.x, dy = nroot.y - g.y;
        if (Math.abs(dx) > tol || Math.abs(dy) > tol) continue;
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = { x: nroot.x, y: nroot.y }; }
      }
    }
    return best;
  }

  // ===================================================================
  // remote cursors (DOM, so they stay crisp and cheap)
  // ===================================================================
  const cursorEls = new Map();
  function cursorEl(p) {
    let el = cursorEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor';
      el.innerHTML =
        `<svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.6 L9.6 12 L15.5 12 Z"
           fill="${p.color}" stroke="#0b1220" stroke-width="1.2" stroke-linejoin="round"/></svg>
         <span class="tag" style="background:${p.color}"></span>`;
      el.querySelector('.tag').textContent = p.name;
      $('cursors').appendChild(el);
      cursorEls.set(p.id, el);
    }
    return el;
  }
  function paintCursors() {
    for (const [id, p] of S.players) {
      if (id === S.me.id) continue;
      const el = cursorEl(p);
      if (!p.cursor) { el.style.display = 'none'; continue; }
      const s = toScreen(p.cursor.x, p.cursor.y);
      const off = 60;
      const vis = s.x > -off && s.y > -off && s.x < canvas.clientWidth + off && s.y < canvas.clientHeight + off;
      el.style.display = vis ? '' : 'none';
      if (vis) el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
  }
  function dropCursor(id) {
    const el = cursorEls.get(id);
    if (el) { el.remove(); cursorEls.delete(id); }
  }

  // ===================================================================
  // input
  // ===================================================================
  function pieceAt(bx, by) {
    const P = S.puzzle, M = S.margin;
    const groups = rootGroups().sort((a, b) => b.z - a.z);   // topmost first
    for (const g of groups) {
      for (const pid of g.pieces) {
        const piece = S.pieces[pid];
        if (!piece) continue;
        const lx = bx - (g.x + piece.col * P.pieceW - M);
        const ly = by - (g.y + piece.row * P.pieceH - M);
        if (lx < 0 || ly < 0 || lx > piece.w || ly > piece.h) continue;
        if (hit.isPointInPath(piece.path, lx, ly)) return g;
      }
    }
    return null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.ready) return;
    // Capture is an optimisation, not a requirement; some pointer ids refuse it.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
    S.pointers.set(e.pointerId, evPos(e));

    if (S.pointers.size === 2) {           // pinch beats everything
      S.drag = S.pan = null;
      const [a, b] = [...S.pointers.values()];
      S.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: S.view.scale };
      return;
    }

    const pos = evPos(e);
    const b = toBoard(pos.x, pos.y);
    // Shift or middle-drag always pans, even when locked, as a deliberate escape.
    const forcePan = e.button === 1 || e.shiftKey;
    const g = forcePan ? null : pieceAt(b.x, b.y);

    if (g) {
      if (g.heldBy && g.heldBy !== S.me.id) { toast('Someone else has that piece'); return; }
      S.drag = { id: g.id, dx: g.x - b.x, dy: g.y - b.y, moved: false };
      g.heldBy = S.me.id;
      g.z = 1e9;                            // pop to front locally right away
      Net.send('grab', { group: g.id });
      canvas.classList.add('dragging');
    } else {
      S.pan = { x: pos.x, y: pos.y, vx: S.view.x, vy: S.view.y };
      canvas.classList.add('panning');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!S.ready) return;
    const pos = evPos(e);
    if (S.pointers.has(e.pointerId)) S.pointers.set(e.pointerId, pos);

    if (S.pinch && S.pointers.size === 2) {
      const [a, b] = [...S.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(mid.x, mid.y, (S.pinch.scale * d / S.pinch.dist) / S.view.scale);
      return;
    }

    const b = toBoard(pos.x, pos.y);

    if (S.drag) {
      const g = S.groups[S.drag.id];
      if (g) {
        g.x = b.x + S.drag.dx;
        g.y = b.y + S.drag.dy;
        S.drag.moved = true;
        const now = performance.now();
        if (now - S.lastMoveSent > MOVE_HZ) {
          S.lastMoveSent = now;
          Net.send('move', { group: g.id, x: g.x, y: g.y });
        }
      }
    } else if (S.pan) {
      S.view.x = S.pan.vx + (pos.x - S.pan.x);
      S.view.y = S.pan.vy + (pos.y - S.pan.y);
    }

    const now = performance.now();
    if (now - S.lastCursorSent > CURSOR_HZ) {
      S.lastCursorSent = now;
      Net.send('cursor', { x: b.x, y: b.y });
    }
  });

  function endPointer(e) {
    S.pointers.delete(e.pointerId);
    if (S.pointers.size < 2) S.pinch = null;

    if (S.drag) {
      const g = S.groups[S.drag.id];
      if (g) Net.send('drop', { group: g.id, x: g.x, y: g.y });
      S.drag = null;
      canvas.classList.remove('dragging');
    }
    S.pan = null;
    canvas.classList.remove('panning');
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  /* If the page is backgrounded or loses focus mid-drag, pointerup never
   * arrives and the piece stays locked to us for everyone else. Let it go. */
  function releaseHeld() {
    if (!S.drag) return;
    const g = S.groups[S.drag.id];
    if (g) Net.send('drop', { group: g.id, x: g.x, y: g.y });
    S.drag = null;
    S.pointers.clear();
    canvas.classList.remove('dragging', 'panning');
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeld(); });
  window.addEventListener('blur', releaseHeld);
  window.addEventListener('pagehide', releaseHeld);

  function zoomAt(sx, sy, factor) {
    const before = toBoard(sx, sy);
    S.view.scale = Math.max(0.08, Math.min(4, S.view.scale * factor));
    const after = toBoard(sx, sy);
    S.view.x += (after.x - before.x) * S.view.scale;
    S.view.y += (after.y - before.y) * S.view.scale;
  }

  canvas.addEventListener('wheel', (e) => {
    if (!S.ready) return;
    e.preventDefault();                   // also stops ctrl+wheel page zoom
    const pos = evPos(e);
    // Trackpad pinch arrives as ctrl+wheel with much smaller deltas.
    const k = e.ctrlKey ? 0.006 : 0.0015;
    zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * k));
  }, { passive: false });

  /* Platform gestures that would otherwise fight the board:
   *  - iOS Safari ignores user-scalable=no, so pinch-zooms the page unless the
   *    gesture events are cancelled;
   *  - long-press on Android and iOS opens a callout over the piece you are
   *    dragging;
   *  - middle-click on Windows starts autoscroll. */
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    canvas.addEventListener(t, (e) => e.preventDefault());
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

  // Two quick taps on the board would otherwise zoom the page on iOS.
  let lastTap = 0;
  canvas.addEventListener('touchend', (e) => {
    const now = performance.now();
    if (now - lastTap < 320) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'f') fitView();
    if (e.key === 'p' && !e.repeat) setPeek(true);   // held, same as the button
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'p') setPeek(false);
  });
  // Losing focus mid-hold must not leave the answer stuck on screen.
  window.addEventListener('blur', () => setPeek(false));

  /* Peek is hold-to-view: hold and the finished picture fades in, let go and it
   * disappears. Nobody leaves the answer sitting on screen by accident. */
  function setPeek(on) {
    if (S.preview === on) return;
    S.preview = on;
    const b = $('btnPreview');
    b.classList.toggle('on', on);
    b.textContent = on ? 'Peeking...' : 'Hold to peek';
    // Everyone sees the picture while anybody holds it.
    Net.send('preview', { on });
  }

  // True while anyone at the table is peeking, including us.
  const anyonePeeking = () => S.preview || S.peekers.size > 0;

  function peekLabel() {
    const names = [...S.peekers]
      .filter((id) => id !== S.me?.id && S.players.has(id))
      .map((id) => S.players.get(id).name);
    return names.length ? names.join(' and ') + (names.length > 1 ? ' are' : ' is') + ' peeking' : '';
  }

  // ===================================================================
  // sound - a small click when pieces lock together
  // ===================================================================
  let audio = null;
  function clack() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t = audio.currentTime;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(660, t);
      o.frequency.exponentialRampToValueAtTime(240, t + 0.07);
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.13);
    } catch { /* audio is a nicety, never a blocker */ }
  }

  // ===================================================================
  // room state
  // ===================================================================
  function loadPuzzle(snapshot, done) {
    const P = snapshot.puzzle;
    S.puzzle = P;
    S.groups = {};
    for (const g of P.groups) {
      S.groups[g.id] = { id: g.id, parent: null, pieces: g.p.slice(), x: g.x, y: g.y, heldBy: g.h, z: g.z };
    }
    // Every piece that was merged away points at whichever root now owns it.
    const owned = new Set();
    for (const g of P.groups) for (const pid of g.p) owned.add(pid);
    for (let i = 0; i < P.rows * P.cols; i++) {
      if (!owned.has(i) && !S.groups[i]) S.groups[i] = { id: i, parent: null, pieces: [], x: 0, y: 0, heldBy: null, z: 0 };
    }

    const img = new Image();
    img.onload = () => {
      S.img = img;
      const built = Pieces.build(img, P);
      S.pieces = [];
      for (const p of built.pieces) S.pieces[p.id] = p;
      S.margin = built.margin;
      S.ready = true;
      resize();
      fitView();
      done && done();
    };
    img.onerror = () => setupError('That image could not be loaded.');
    // Deliberately no crossOrigin: we only ever draw this image, never read its
    // pixels back, so a tainted canvas costs us nothing and CORS-less hosts work.
    img.src = snapshot.image.dataUrl;
  }

  function applySnapshot(snap) {
    S.code = snap.code;
    S.hostId = snap.hostId;
    S.startedAt = snap.startedAt;
    S.solvedAt = snap.solvedAt;
    S.players.clear();
    S.media.clear();
    for (const p of snap.players) {
      S.players.set(p.id, p);
      // Joining halfway through: pick up who already has a mic or camera on.
      if (p.media && (p.media.audio || p.media.video)) S.media.set(p.id, p.media);
    }
    $('roomCode').textContent = snap.code;
    $('waitCode').textContent = snap.code;
    renderPlayers();
    $('chatLog').innerHTML = '';
    (snap.chat || []).forEach(addChat);
  }

  function progress() {
    if (!S.puzzle) return 0;
    const total = S.puzzle.rows * S.puzzle.cols;
    if (total < 2) return 100;
    const live = rootGroups().filter((g) => g.pieces.length > 0).length;
    return Math.round(((total - live) / (total - 1)) * 100);
  }

  function renderStats() {
    const pct = progress();
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = pct + '%';
  }

  /* Scoreboard: who has locked in how many pieces, best first. */
  function renderPlayers() {
    const ul = $('playerList');
    ul.innerHTML = '';
    const rows = [...S.players.values()]
      .map((p) => ({ p, n: S.placed.get(p.id) || 0 }))
      .sort((a, b) => b.n - a.n || a.p.name.localeCompare(b.p.name));
    const top = Math.max(1, ...rows.map((r) => r.n));

    rows.forEach(({ p, n }, i) => {
      const me = p.id === S.me?.id;
      const leading = n > 0 && n === top;
      const li = document.createElement('li');
      li.className = 'prow' + (me ? ' is-me' : '');
      li.innerHTML =
        `<span class="dot" style="background:${p.color}"></span>
         <span class="pname${me ? ' self' : ''}">${esc(p.name)}${me ? ' (you)' : ''}</span>
         ${p.id === S.hostId ? '<span class="host">HOST</span>' : ''}
         ${(() => {
            const m = p.id === S.me?.id
              ? { audio: RTC.audioOn, video: RTC.videoOn }
              : (S.media.get(p.id) || {});
            return (m.audio ? '<span class="av" title="Mic on">🎤</span>' : '') +
                   (m.video ? '<span class="av" title="Camera on">📹</span>' : '');
          })()}
         ${leading && rows.length > 1 ? '<span class="crown" title="Most pieces">👑</span>' : ''}
         <span class="pcount">${n}</span>
         <span class="pbar"><i style="width:${Math.round((n / top) * 100)}%;background:${p.color}"></i></span>`;
      ul.appendChild(li);
    });

    const done = [...S.placed.values()].reduce((a, b) => a + b, 0);
    const total = S.puzzle ? S.puzzle.rows * S.puzzle.cols : 0;
    $('pieceTally').textContent = total ? `${done} / ${total - 1}` : '';
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function addChat(entry) {
    const log = $('chatLog');
    const div = document.createElement('div');
    if (entry.sys) {
      div.className = 'sys';
      div.textContent = entry.text;
    } else {
      div.className = 'msg';
      div.innerHTML = `<b style="color:${entry.color}">${esc(entry.name)}</b> ${esc(entry.text)}`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  const sysChat = (text) => addChat({ sys: true, text });

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  setInterval(() => {
    if (!S.startedAt) return;
    const end = S.solvedAt || Date.now();
    const s = Math.max(0, Math.floor((end - S.startedAt) / 1000));
    $('timer').textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);

  /* Connection quality.
   *
   * A weak connection is the thing most likely to make a shared board feel
   * broken - pieces jump, someone else's drag stutters - and without a readout
   * players blame the game. Measure the real round trip and say so plainly.
   * The median of recent samples is used so one unlucky spike doesn't flip the
   * indicator to red. */
  const NET = { samples: [], rtt: null, state: 'connecting', lastPong: 0 };

  function netQuality() {
    if (NET.state !== 'online') return NET.state;
    if (NET.rtt == null) return 'measuring';
    if (NET.rtt < 120) return 'good';
    if (NET.rtt < 300) return 'ok';
    return 'weak';
  }

  function paintNet() {
    const el = $('netStat');
    const q = netQuality();
    el.dataset.q = q;
    const label = {
      good: 'Connection is good',
      ok: 'Connection is a bit slow',
      weak: 'Weak connection - pieces may lag behind',
      offline: 'Disconnected - trying to reconnect',
      connecting: 'Connecting...',
      measuring: 'Measuring connection...'
    }[q];
    el.title = label + (NET.rtt != null ? ` (${NET.rtt} ms round trip)` : '');
    el.querySelector('.ms').textContent =
      q === 'offline' ? 'offline' : (NET.rtt != null ? NET.rtt + ' ms' : '...');
  }

  function pingOnce() {
    if (!Net.ready) return;
    const t = performance.now();
    if (Net.send('ping', { t })) NET.pending = t;
  }

  Net.on('pong', (m) => {
    const rtt = Math.round(performance.now() - (m.t || NET.pending || 0));
    if (rtt < 0 || rtt > 60000) return;
    NET.lastPong = Date.now();
    NET.samples.push(rtt);
    if (NET.samples.length > 7) NET.samples.shift();
    const sorted = [...NET.samples].sort((a, b) => a - b);
    NET.rtt = sorted[Math.floor(sorted.length / 2)];      // median
    paintNet();
  });

  Net.on('open', () => { NET.state = 'online'; paintNet(); pingOnce(); });
  Net.on('close', () => { NET.state = 'offline'; NET.rtt = null; NET.samples.length = 0; paintNet(); });

  setInterval(() => {
    pingOnce();
    // No reply for a while while claiming to be online means the link is dead.
    if (NET.state === 'online' && NET.lastPong && Date.now() - NET.lastPong > 12000) {
      NET.rtt = null; paintNet();
    }
  }, 3000);
  paintNet();

  // ===================================================================
  // network events
  // ===================================================================
  Net.on('error', (m) => {
    if ($('lobby').hidden) { toast(m.message); setupError(m.message); }
    else { $('lobbyError').textContent = m.message; $('lobbyError').hidden = false; }
  });

  Net.on('joined', (m) => {
    S.me = m.you;
    RTC.setId(m.you.id);
    applySnapshot(m.room);
    $('lobby').hidden = true;
    $('game').hidden = false;
    resize();

    if (m.room.puzzle) {
      $('wait').hidden = true;
      // The scoreboard's totals need the puzzle, so redraw it once that exists.
      loadPuzzle(m.room, () => { renderStats(); renderPlayers(); });
    } else if (S.me.id === S.hostId) {
      $('wait').hidden = true;
      openSetup();
    } else {
      $('wait').hidden = false;
    }
    history.replaceState(null, '', '#' + S.code);
    // Remember this seat so a refresh drops us straight back in.
    try {
      sessionStorage.setItem('jt.room', S.code);
      sessionStorage.setItem('jt.color', S.me.color);
    } catch { /* private mode: auto-rejoin is optional */ }
  });

  Net.on('started', (m) => {
    $('setup').hidden = true;
    $('wait').hidden = true;
    $('win').hidden = true;
    S.placed.clear();
    applySnapshot(m.room);
    S.ready = false;
    loadPuzzle(m.room, () => { renderStats(); renderPlayers(); toast('Board ready - go!'); });
  });

  Net.on('playerJoined', (m) => {
    S.players.set(m.player.id, m.player);
    if (m.player.media && (m.player.media.audio || m.player.media.video)) {
      S.media.set(m.player.id, m.player.media);
    }
    // If we're already on a call, be ready for the newcomer.
    if (RTC.anyOn) RTC.connect([m.player.id]);
    renderRoster();
    renderPlayers();
    sysChat(`${m.player.name} joined`);
  });

  Net.on('playerLeft', (m) => {
    const p = S.players.get(m.id);
    S.players.delete(m.id);
    dropCursor(m.id);
    RTC.drop(m.id);
    S.media.delete(m.id);
    S.peekers.delete(m.id);
    renderRoster();
    document.getElementById('tile-' + m.id)?.remove();
    renderPlayers();
    if (p) sysChat(`${p.name} left`);
  });

  Net.on('host', (m) => { S.hostId = m.hostId; renderPlayers(); });

  Net.on('cursor', (m) => {
    const p = S.players.get(m.id);
    if (p) p.cursor = { x: m.x, y: m.y };
  });

  Net.on('grabbed', (m) => {
    const g = S.groups[m.group];
    if (!g) return;
    g.heldBy = m.by;
    g.z = m.z;
  });

  Net.on('grabDenied', (m) => {
    if (S.drag && S.drag.id === m.group) { S.drag = null; canvas.classList.remove('dragging'); }
    const g = S.groups[m.group];
    if (g && g.heldBy === S.me.id) g.heldBy = null;
    toast('Someone else grabbed that first');
  });

  Net.on('released', (m) => { const g = S.groups[m.group]; if (g) g.heldBy = null; });

  Net.on('moved', (m) => {
    const g = S.groups[m.group];
    if (!g || (S.drag && S.drag.id === m.group)) return;   // never fight our own drag
    g.x = m.x; g.y = m.y;
  });

  Net.on('dropped', (m) => {
    const g = S.groups[m.group];
    if (g) { g.x = m.x; g.y = m.y; g.heldBy = null; }

    if (m.merge) {
      const keep = S.groups[m.merge.keep];
      for (const goneId of m.merge.gone) {
        const gone = S.groups[goneId];
        if (!gone || gone === keep) continue;
        for (const pid of gone.pieces) if (!keep.pieces.includes(pid)) keep.pieces.push(pid);
        gone.pieces = [];
        gone.parent = keep.id;
      }
      keep.x = m.merge.x; keep.y = m.merge.y; keep.z = m.merge.z; keep.heldBy = null;
      S.placed.set(m.by, (S.placed.get(m.by) || 0) + 1);
      clack();
      renderPlayers();
    }
    renderStats();

    if (m.solved && !S.solvedAt) {
      S.solvedAt = m.solved;
      showWin();
    }
  });

  Net.on('preview', (m) => {
    if (m.on) S.peekers.add(m.id); else S.peekers.delete(m.id);
    const who = peekLabel();
    if (who) toast(who);
  });

  Net.on('chat', (m) => addChat(m.entry));

  Net.on('close', () => toast('Connection lost - reconnecting...'));

  // Rejoin the same room automatically after a drop.
  Net.setResume(() => {
    if (!S.me || !S.code) return;
    Net.send('join', { code: S.code, name: S.me.name, color: S.me.color });
  });

  function showWin() {
    const s = Math.floor((S.solvedAt - S.startedAt) / 1000);
    const mins = Math.floor(s / 60), secs = s % 60;
    $('winText').textContent =
      `${S.puzzle.rows * S.puzzle.cols} pieces, finished together in ${mins}m ${secs}s.`;

    const rows = [...S.players.values()]
      .map((p) => ({ p, n: S.placed.get(p.id) || 0 }))
      .sort((a, b) => b.n - a.n);
    $('winScores').innerHTML = rows.map(({ p, n }, i) =>
      `<li><span class="medal">${['🥇', '🥈', '🥉'][i] || '·'}</span>
         <span class="dot" style="background:${p.color}"></span>
         <span class="pname">${esc(p.name)}${p.id === S.me.id ? ' (you)' : ''}</span>
         <b>${n}</b></li>`).join('');

    $('winAgain').hidden = S.me.id !== S.hostId;
    $('win').hidden = false;
    celebrate();
  }

  /* ---------------- celebration ---------------- */
  const fx = $('fx');
  const fxc = fx.getContext('2d');
  let confetti = [];
  let fxRunning = false;

  function celebrate() {
    const w = fx.clientWidth, h = fx.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = Math.round(w * dpr);
    fx.height = Math.round(h * dpr);
    fxc.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colours = [...S.players.values()].map((p) => p.color)
      .concat(['#ffd166', '#ef476f', '#06d6a0', '#f7b267', '#c792ea']);

    confetti = Array.from({ length: 220 }, () => ({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.6,
      vx: (Math.random() - 0.5) * 1.6,
      vy: 2 + Math.random() * 3.6,
      w: 5 + Math.random() * 7,
      h: 8 + Math.random() * 10,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.28,
      col: colours[Math.floor(Math.random() * colours.length)]
    }));

    fx.classList.add('on');
    if (!fxRunning) { fxRunning = true; requestAnimationFrame(tickFx); }
  }

  function tickFx() {
    const w = fx.clientWidth, h = fx.clientHeight;
    fxc.clearRect(0, 0, w, h);
    let alive = 0;
    for (const c of confetti) {
      c.x += c.vx; c.y += c.vy; c.rot += c.spin;
      c.vy += 0.045;                      // gravity
      c.vx *= 0.995;
      if (c.y < h + 40) alive++;
      fxc.save();
      fxc.translate(c.x, c.y);
      fxc.rotate(c.rot);
      fxc.fillStyle = c.col;
      fxc.globalAlpha = c.y > h * 0.82 ? Math.max(0, 1 - (c.y - h * 0.82) / (h * 0.25)) : 1;
      fxc.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      fxc.restore();
    }
    if (alive > 0) { requestAnimationFrame(tickFx); }
    else { fxRunning = false; confetti = []; fxc.clearRect(0, 0, w, h); fx.classList.remove('on'); }
  }

  // ===================================================================
  // lobby
  // ===================================================================
  let chosenColor = COLORS[0];
  let takenColors = new Set();     // colours already used in the room being joined

  const swatchEls = [];
  (function buildSwatches() {
    const box = $('swatches');
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.className = i === 0 ? 'on' : '';
      b.onclick = () => {
        if (b.classList.contains('taken')) return;
        chosenColor = c;
        swatchEls.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      };
      swatchEls.push(b);
      box.appendChild(b);
    });
  })();

  /* Grey out colours somebody in the target room already has, and move our own
   * pick off one if it just became unavailable. */
  function paintSwatches() {
    let mineTaken = false;
    swatchEls.forEach((b, i) => {
      const c = COLORS[i];
      const taken = takenColors.has(c.toLowerCase());
      b.classList.toggle('taken', taken);
      b.title = taken ? c + ' - already taken' : c;
      if (taken && c === chosenColor) mineTaken = true;
    });
    if (mineTaken) {
      const free = COLORS.find((c) => !takenColors.has(c.toLowerCase()));
      if (free) {
        chosenColor = free;
        swatchEls.forEach((x, i) => x.classList.toggle('on', COLORS[i] === free));
      }
    }
    $('colourNote').textContent = takenColors.size ? '- greyed ones are taken' : '';
  }

  const savedName = localStorage.getItem('jt.name');
  if (savedName) $('name').value = savedName;

  /* Without a name everyone shows up as "Player", which is useless the moment
   * two people join. So the buttons stay disabled until there is one. */
  function refreshNameGate() {
    const ok = !!$('name').value.trim();
    $('btnCreate').disabled = !ok;
    $('btnJoin').disabled = !ok || $('btnJoin').dataset.roomBad === '1';
    if (ok) $('lobbyError').hidden = true;
  }
  $('name').addEventListener('input', refreshNameGate);

  function enter(kind, code) {
    const name = ($('name').value || '').trim();
    if (!name) {
      $('lobbyError').textContent = 'Please enter your name first.';
      $('lobbyError').hidden = false;
      $('name').focus();
      return;
    }
    localStorage.setItem('jt.name', name);
    $('lobbyError').hidden = true;
    const go = () => Net.send(kind, { name, color: chosenColor, code });
    if (Net.ready) { go(); return; }
    // One-shot: a later reconnect must not create a second room.
    let fired = false;
    Net.on('open', () => { if (!fired) { fired = true; go(); } });
  }

  // --- create / join tabs ---------------------------------------------
  function showTab(which) {
    const joining = which === 'join';
    $('tabCreate').classList.toggle('on', !joining);
    $('tabJoin').classList.toggle('on', joining);
    $('paneCreate').hidden = joining;
    $('paneJoin').hidden = !joining;
    $('lobbyError').hidden = true;
    if (joining) { $('joinCode').focus(); askPeek(); }
    else { takenColors = new Set(); paintSwatches(); }
  }
  $('tabCreate').onclick = () => showTab('create');
  $('tabJoin').onclick = () => showTab('join');

  /* Ask the server what's in a room before committing to it, so the join screen
   * can show who is already playing and which colours are gone. */
  let peekTimer = null;
  let peekedCode = null;
  function askPeek() {
    const code = $('joinCode').value.trim().toUpperCase();
    clearTimeout(peekTimer);
    if (code.length < 4) {
      peekedCode = null;
      $('roomPreview').hidden = true;
      $('btnJoin').dataset.roomBad = '1';
      $('btnJoin').disabled = true;
      takenColors = new Set();
      paintSwatches();
      return;
    }
    peekTimer = setTimeout(() => {
      peekedCode = code;
      if (!Net.send('peek', { code })) Net.on('open', () => Net.send('peek', { code }));
    }, 220);
  }
  $('joinCode').oninput = askPeek;
  $('joinCode').onkeydown = (e) => {
    if (e.key === 'Enter' && !$('btnJoin').disabled) { e.preventDefault(); $('btnJoin').click(); }
  };

  Net.on('peek', (m) => {
    if (m.code !== peekedCode) return;              // a stale reply for an older code
    const box = $('roomPreview');
    box.hidden = false;

    if (!m.found) {
      box.className = 'room-preview bad';
      box.innerHTML = `<b>No room called <span class="code">${esc(m.code)}</span></b>
        <p>Check the code, or ask for the invite link.</p>`;
      $('btnJoin').dataset.roomBad = '1';
      $('btnJoin').disabled = true;
      takenColors = new Set();
      paintSwatches();
      return;
    }

    takenColors = new Set(m.players.map((p) => p.color.toLowerCase()));
    paintSwatches();

    const who = m.players.length
      ? m.players.map((p) =>
          `<span class="who"><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')
      : '<span class="muted">Nobody here yet - you\'ll be first in.</span>';

    box.className = 'room-preview' + (m.full ? ' bad' : ' good');
    box.innerHTML =
      `<b>${m.players.length} ${m.players.length === 1 ? 'person' : 'people'} in
         <span class="code">${esc(m.code)}</span></b>
       <div class="whos">${who}</div>
       <p>${m.started
            ? `Playing <b>${esc(m.picture || 'a puzzle')}</b> - ${m.pieces} pieces. You can join mid-game.`
            : 'Still choosing a picture.'}</p>` +
      (m.full ? '<p class="warn">This room is full.</p>' : '');
    $('btnJoin').dataset.roomBad = m.full ? '1' : '0';
    $('btnJoin').disabled = !!m.full || !$('name').value.trim();
  });

  $('btnCreate').onclick = () => enter('create');
  $('btnJoin').onclick = () => {
    const code = $('joinCode').value.trim().toUpperCase();
    if (code.length < 4) {
      $('lobbyError').textContent = 'Enter the 4-character room code.';
      $('lobbyError').hidden = false;
      return;
    }
    enter('join', code);
  };
  // Arriving on a shared link opens the join tab with the code already in.
  const linkCode = location.hash.slice(1).toUpperCase();
  if (linkCode) {
    $('joinCode').value = linkCode;
    showTab('join');
  }

  /* If this tab was already sitting in this room, a refresh (or a crash) should
   * put us straight back on the board rather than at the lobby. A first-time
   * visitor following someone's invite link still gets to pick a name. */
  try {
    const wasIn = sessionStorage.getItem('jt.room');
    const savedColor = sessionStorage.getItem('jt.color');
    if (wasIn && wasIn === linkCode && savedName) {
      if (savedColor) chosenColor = savedColor;
      enter('join', linkCode);
    }
  } catch { /* no sessionStorage, fall through to the lobby */ }

  // ===================================================================
  // setup (host only)
  // ===================================================================
  function setupError(msg) {
    const el = $('setupError');
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg; el.hidden = false;
  }

  function setChosen(src) {
    S.pendingSetup = src;
    $('chosen').hidden = false;
    $('pickHint').hidden = true;
    $('chosenImg').src = src.thumb || src.dataUrl;   // avoid pulling the big file twice
    $('chosenTitle').textContent = src.title;
    $('chosenMeta').textContent = src.artist || `${src.w} x ${src.h}`;
    $('btnStart').disabled = false;
    setupError(null);
  }

  let galleryBuilt = false;
  function openSetup() {
    $('setup').hidden = false;
    setupError(null);
    $('pickHint').hidden = !!S.pendingSetup;
    $('btnStart').disabled = !S.pendingSetup;   // reopening keeps the last choice
    if (galleryBuilt) return;
    galleryBuilt = true;
    const grid = $('galleryGrid');
    Gallery.all().forEach((item, i) => {
      const b = document.createElement('button');
      b.innerHTML =
        `<img src="${item.thumb}" alt="${esc(item.title)}" loading="lazy">
         <span class="diff ${item.difficulty}">${item.difficulty}</span>
         <div class="cap">${esc(item.title)}<span>${esc(item.artist)}</span></div>`;
      // The detail score is what decided this painting was worth shipping;
      // say so rather than making people find out after 80 pieces.
      b.title = `${item.title} - ${item.artist}. Detail ${item.detail}: ` +
        (item.difficulty === 'easy'
          ? 'plenty of texture, every piece is easy to place'
          : 'a few plainer patches, a bit trickier');
      // If a painting can't be fetched, don't offer a tile that leads nowhere.
      b.querySelector('img').onerror = () => b.remove();
      b.onclick = () => {
        [...grid.children].forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        setChosen(item);
      };
      grid.appendChild(b);
    });
  }

  // Shrink big uploads: 1600px is plenty of detail for a 1200-unit board.
  function fileToSource(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read that file.'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not an image we can read.'));
        img.onload = () => {
          const max = 1600;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.85), w, h, title: file.name.slice(0, 40) });
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  $('fileInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setupError(null);
    try {
      const src = await fileToSource(f);
      [...$('galleryGrid').children].forEach((x) => x.classList.remove('on'));
      setChosen(src);
    } catch (err) { setupError(err.message); }
  };

  $('btnStart').onclick = () => {
    if (!S.pendingSetup) return;
    $('btnStart').disabled = true;
    setupError('Cutting the pieces...');
    Net.send('setup', {
      dataUrl: S.pendingSetup.dataUrl,
      imageW: S.pendingSetup.w,
      imageH: S.pendingSetup.h,
      title: S.pendingSetup.title,
      pieces: DEFAULT_PIECES
    });
  };

  // ===================================================================
  // board chrome
  // ===================================================================
  /* Light by default - paintings read better on a light wall - with a dark
   * set for playing at night. Remembered per browser. */
  function setTheme(mode) {
    const dark = mode === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('btnTheme').textContent = dark ? '\u2600\uFE0F' : '\u{1F319}';
    $('btnTheme').title = dark ? 'Switch to the light gallery' : 'Switch to dark for night play';
    try { localStorage.setItem('jt.theme', dark ? 'dark' : 'light'); } catch { /* fine */ }
    buildFelt();
    resize();
  }
  $('btnTheme').onclick = () =>
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  try { setTheme(localStorage.getItem('jt.theme') || 'light'); } catch { setTheme('light'); }

  $('btnFit').onclick = fitView;

  const pv = $('btnPreview');
  pv.addEventListener('pointerdown', (e) => { e.preventDefault(); setPeek(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) =>
    pv.addEventListener(t, () => setPeek(false)));
  pv.addEventListener('contextmenu', (e) => e.preventDefault());

  /* The panel is a sidebar on desktop and a bottom sheet on a phone. On a
   * phone it covers the board, so it has to be dismissable the way a sheet is:
   * tap anywhere outside it, or drag the handle down. */
  const isSheet = () => window.matchMedia('(max-width: 720px)').matches;

  function setPanel(open) {
    $('side').classList.toggle('hidden', !open);
    $('btnSide').classList.toggle('on', open);
    $('btnSide').setAttribute('aria-expanded', String(open));
    fitView();
  }
  const panelOpen = () => !$('side').classList.contains('hidden');

  $('btnSide').onclick = (e) => {
    e.stopPropagation();
    const open = !panelOpen();
    setPanel(open);
    // On a phone the sheet is an overlay, so give Back something to close.
    if (isSheet()) { if (open) window.__jtOverlay.push(); else window.__jtOverlay.pop(); }
  };

  // Tapping the board (or anything outside the sheet) closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!isSheet() || !panelOpen()) return;
    if (e.target.closest('#side') || e.target.closest('#btnSide')) return;
    setPanel(false);
  }, true);

  /* Drag the handle down to dismiss. Follows the finger, and only commits if
   * you pulled far enough or flicked - otherwise it springs back. */
  (() => {
    const side = $('side'), grip = $('sheetGrip');
    let startY = 0, dy = 0, t0 = 0, dragging = false;

    grip.addEventListener('pointerdown', (e) => {
      if (!isSheet()) return;
      dragging = true; startY = e.clientY; dy = 0; t0 = performance.now();
      side.style.transition = 'none';
      try { grip.setPointerCapture(e.pointerId); } catch { /* optional */ }
      e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);          // downward only
      side.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    });

    const end = () => {
      if (!dragging) return;
      dragging = false;
      side.style.transition = '';
      side.style.transform = '';
      const flick = dy / Math.max(1, performance.now() - t0) > 0.5;
      if (dy > side.offsetHeight * 0.28 || flick) setPanel(false);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('click', () => { if (isSheet()) setPanel(false); });
  })();

  /* A small popover rather than swapping the button's label: relabelling it
   * resized the button and shoved the whole toolbar sideways. */
  const closeLeave = () => { $('leaveConfirm').hidden = true; $('btnLeave').classList.remove('on'); };
  $('btnLeave').onclick = (e) => {
    e.stopPropagation();
    const open = $('leaveConfirm').hidden;
    $('leaveConfirm').hidden = !open;
    $('btnLeave').classList.toggle('on', open);
  };
  $('leaveNo').onclick = closeLeave;
  $('leaveYes').onclick = () => {
    try { sessionStorage.removeItem('jt.room'); } catch { /* fine */ }
    RTC.leaveAll();
    location.href = location.origin + '/';
  };
  document.addEventListener('pointerdown', (e) => {
    if (!$('leaveConfirm').hidden && !e.target.closest('.leave-wrap')) closeLeave();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLeave(); });

  // Chat takes a lot of panel height; let people fold it away.
  const setChatHidden = (hide) => {
    $('chatBody').hidden = hide;
    $('btnChatToggle').textContent = hide ? 'show' : 'hide';
    document.querySelector('.chat-panel').classList.toggle('folded', hide);
    try { localStorage.setItem('jt.chatHidden', hide ? '1' : '0'); } catch { /* fine */ }
  };
  $('btnChatToggle').onclick = () => setChatHidden(!$('chatBody').hidden);
  try { if (localStorage.getItem('jt.chatHidden') === '1') setChatHidden(true); } catch { /* fine */ }
  $('winClose').onclick = () => { $('win').hidden = true; };
  $('winAgain').onclick = () => {
    $('win').hidden = true;
    openSetup();
  };

  $('copyLink').onclick = async () => {
    const link = location.origin + '/#' + S.code;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch {
      // No clipboard permission (or insecure origin): show it instead of
      // opening a prompt(), which would freeze the board.
      toast(link);
    }
  };

  // ===================================================================
  // voice & video
  //
  // Remote cameras float over the board as picture-in-picture windows you can
  // drag and resize, rather than sitting in a fixed sidebar grid - on a puzzle
  // you want faces near whatever you are looking at, not pinned to one corner.
  // ===================================================================
  const pipLayer = $('pipLayer');
  const pips = new Map();          // playerId -> { el, video, x, y, w }

  const PIP_MIN = 120, PIP_MAX = 480, PIP_RATIO = 3 / 4;   // height = w * ratio

  function clampPip(p) {
    const maxX = Math.max(0, pipLayer.clientWidth - p.w);
    const maxY = Math.max(0, pipLayer.clientHeight - p.w * PIP_RATIO - 22);
    p.x = Math.min(Math.max(0, p.x), maxX);
    p.y = Math.min(Math.max(0, p.y), maxY);
  }

  function placePip(p) {
    clampPip(p);
    p.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    p.el.style.width = p.w + 'px';
  }

  // Stack new windows down the left so they never land on top of each other.
  function nextPipSpot(w) {
    const n = pips.size;
    return { x: 14, y: 14 + n * (w * PIP_RATIO + 30) };
  }

  function makePip(id, label, colour, isSelf) {
    let p = pips.get(id);
    if (p) return p;

    const w = 200;
    const spot = nextPipSpot(w);
    const el = document.createElement('div');
    el.className = 'pip' + (isSelf ? ' is-self' : '');
    el.innerHTML =
      '<video autoplay playsinline></video>' +
      '<div class="pip-blank"><span></span></div>' +
      '<div class="pip-bar">' +
        '<i class="pip-dot"></i><span class="pip-name"></span>' +
        '<span class="pip-mic" title="Microphone"></span>' +
      '</div>' +
      '<div class="pip-grip" title="Drag to resize"></div>';
    el.querySelector('.pip-dot').style.background = colour;
    el.querySelector('.pip-name').textContent = label;

    const video = el.querySelector('video');
    // Always muted: sound comes from the dedicated <audio> sink, and your own
    // stream must never be audible to you at all.
    video.muted = true;

    p = { el, video, x: spot.x, y: spot.y, w };
    pips.set(id, p);
    pipLayer.appendChild(el);
    placePip(p);
    wirePip(p);
    return p;
  }

  /* Drag anywhere on the window, resize from the corner grip. Pointer capture
   * keeps the gesture attached even when the pointer outruns the element. */
  function wirePip(p) {
    let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0;

    const down = (e, which) => {
      mode = which;
      sx = e.clientX; sy = e.clientY;
      ox = p.x; oy = p.y; ow = p.w;
      p.el.classList.add('busy');
      p.el.style.zIndex = String(++pipTop);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* optional */ }
      e.preventDefault();
      e.stopPropagation();
    };

    const move = (e) => {
      if (!mode) return;
      if (mode === 'drag') {
        p.x = ox + (e.clientX - sx);
        p.y = oy + (e.clientY - sy);
      } else {
        p.w = Math.min(PIP_MAX, Math.max(PIP_MIN, ow + (e.clientX - sx)));
      }
      placePip(p);
      e.preventDefault();
    };

    const up = () => { mode = null; p.el.classList.remove('busy'); };

    p.el.addEventListener('pointerdown', (e) => down(e, 'drag'));
    p.el.addEventListener('pointermove', move);
    p.el.addEventListener('pointerup', up);
    p.el.addEventListener('pointercancel', up);

    const grip = p.el.querySelector('.pip-grip');
    grip.addEventListener('pointerdown', (e) => down(e, 'resize'));
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }
  let pipTop = 1;

  function dropPip(id) {
    const p = pips.get(id);
    if (!p) return;
    p.video.srcObject = null;
    p.el.remove();
    pips.delete(id);
  }

  // Keep windows on screen when the board resizes.
  window.addEventListener('resize', () => pips.forEach(placePip));

  const mediaOf = (id) => S.media.get(id) || { audio: false, video: false };

  /* A window exists only while that player's camera is on; mic-only players are
   * shown in the roster instead of as a black rectangle. */
  function syncPips() {
    for (const [id, p] of S.players) {
      const m = id === S.me?.id
        ? { audio: RTC.audioOn, video: RTC.videoOn }
        : mediaOf(id);
      if (m.video) {
        const pip = makePip(id, p.name + (id === S.me?.id ? ' (you)' : ''), p.color, id === S.me?.id);
        pip.el.querySelector('.pip-mic').textContent = m.audio ? '\u{1F399}\uFE0F' : '\u{1F507}';
        pip.el.classList.toggle('muted', !m.audio);
        /* The stream can arrive before this tile exists - the track and the
         * rtcState announcement race - so bind whatever we already hold. */
        const existing = id === S.me?.id ? RTC.selfStream : RTC.streamOf(id);
        if (existing) attachStream(id, existing);
      } else {
        dropPip(id);
      }
    }
    for (const id of [...pips.keys()]) if (!S.players.has(id)) dropPip(id);
  }

  function attachStream(id, stream) {
    const p = pips.get(id);
    if (!p) return;

    const track = stream.getVideoTracks()[0];

    /* Re-bind whenever the track set changes, not just when the stream object
     * changes. A peer's audio and video arrive as separate ontrack events on the
     * SAME MediaStream, so when the mic connects first this element gets bound
     * to a stream that has no video yet. Adding the camera track later mutates
     * that same object, so an identity check never fires again - and Safari does
     * not start rendering a track added after assignment. The result was a
     * permanently black tile while audio worked perfectly.
     *
     * Clearing srcObject before reassigning is what actually forces the element
     * to pick up the new track. */
    const bound = p.video.srcObject;
    const boundVideo = bound ? bound.getVideoTracks().length : -1;
    if (bound !== stream || boundVideo !== stream.getVideoTracks().length) {
      p.video.srcObject = null;
      p.video.srcObject = stream;
      p.video.play().catch(() => { /* autoplay policy; the tap handler retries */ });
    }

    /* Say WHY a tile is blank rather than showing an unexplained black box. */
    const paint = () => {
      const t = p.video.srcObject && p.video.srcObject.getVideoTracks()[0];
      let why = null;
      if (!t) why = 'no video yet';
      else if (t.readyState === 'ended') why = 'camera off';
      else if (t.muted || !t.enabled) why = 'camera paused';
      p.el.classList.toggle('blank', !!why);
      const label = p.el.querySelector('.pip-blank span');
      if (label && why) label.textContent = why;
    };
    if (track && p.watched !== track) {
      p.watched = track;
      track.addEventListener('mute', paint);
      track.addEventListener('unmute', paint);
      track.addEventListener('ended', paint);
    }
    paint();
  }

  /* Every remote stream gets its own hidden <audio> element, whether or not
    * that person has a camera on. This is the whole reason nobody was audible:
    * audio used to ride on the PiP <video>, and a mic-only peer never got a PiP,
    * so their voice was attached to nothing at all.
    *
    * Browsers also refuse to start playback until the page has seen a real user
    * gesture, so play() is retried from the mic/camera buttons and from the
    * first tap anywhere. iOS Safari is the strict one here. */
  const sinks = new Map();

  function audioSink(id, stream) {
    let el = sinks.get(id);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');       // older iOS reads the attribute
      $('audioSinks').appendChild(el);
      sinks.set(id, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => { pendingAudio = true; paintCallBar(); });
    return el;
  }

  function dropSink(id) {
    const el = sinks.get(id);
    if (!el) return;
    el.srcObject = null;
    el.remove();
    sinks.delete(id);
  }

  let pendingAudio = false;
  function unlockAudio() {
    let blocked = false;
    for (const el of sinks.values()) {
      el.play().catch(() => { blocked = true; });
    }
    if (!blocked) pendingAudio = false;
    paintCallBar();
  }
  // Any tap counts as the gesture browsers are waiting for.
  document.addEventListener('pointerdown', () => { if (pendingAudio) unlockAudio(); }, { passive: true });

  RTC.init(null, {
    onStream(id, stream) {
      // Sound first: this must happen for audio-only peers too.
      if (stream.getAudioTracks().length) audioSink(id, stream);

      const m = mediaOf(id);
      if (!m.video) { dropPip(id); return; }
      const player = S.players.get(id);
      makePip(id, player ? player.name : 'Player', player ? player.color : '#888', false);
      attachStream(id, stream);
    },
    onGone: (id) => { dropPip(id); dropSink(id); },
    onNote: (m) => { $('rtcNote').textContent = m; },
    onPeerState: () => renderRoster()
  });

  // The scoreboard already lists everyone with their mic/camera state, so a
  // second list of the same people was pure duplication.
  const renderRoster = () => paintCallBar();

  Net.on('rtc', (m) => RTC.handle(m));

  Net.on('rtcState', (m) => {
    S.media.set(m.id, { audio: !!m.audio, video: !!m.video });
    // Somebody turned something on: make sure we have a connection to them.
    if (m.audio || m.video) RTC.connect([m.id]);
    else RTC.drop(m.id);
    syncPips();
    renderRoster();
    renderPlayers();
  });

  async function toggleMedia(kind) {
    const btn = kind === 'audio' ? $('btnMic') : $('btnCam');
    const want = kind === 'audio' ? !RTC.audioOn : !RTC.videoOn;
    btn.disabled = true;
    try {
      // Opening a connection to everyone before publishing means their browser
      // is ready to receive the moment the track appears.
      if (want) RTC.connect([...S.players.keys()]);
      const stream = kind === 'audio' ? await RTC.setAudio(want) : await RTC.setVideo(want);
      unlockAudio();                        // this click is the gesture browsers want
      $('rtcNote').textContent = '';
      if (!RTC.anyOn) RTC.leaveAll();
      syncPips();
      if (RTC.videoOn && stream) attachStream(S.me.id, stream);
    } catch (e) {
      $('rtcNote').textContent =
        e.name === 'NotAllowedError'
          ? 'Permission denied. Allow the mic or camera from your browser address bar.'
          : e.name === 'NotFoundError'
            ? 'No ' + (kind === 'audio' ? 'microphone' : 'camera') + ' found on this device.'
            : e.message;
    }
    btn.disabled = false;
    paintCallBar();
    renderRoster();
    renderPlayers();
  }

  /* Line icons rather than emoji: emoji render differently on every platform
   * and read as clip-art next to real UI. */
  const ICON = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    micOff: '<path d="M12 2a3 3 0 0 0-3 3v6"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M19 10v2a7 7 0 0 1-11 5.7"/><path d="M5 10v2a7 7 0 0 0 2 4.9"/><path d="M12 19v3"/><path d="M3 3l18 18"/>',
    cam: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    camOff: '<path d="M23 7l-7 5 4 2.9"/><path d="M10 5h4a2 2 0 0 1 2 2v3"/><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"/><path d="M3 3l18 18"/>'
  };
  const svg = (paths) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';

  function paintCallBar() {
    const set = (el, on, onIcon, offIcon, what) => {
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
      el.querySelector('.ic').innerHTML = svg(on ? onIcon : offIcon);
      el.title = on ? `Turn your ${what} off` : `Turn your ${what} on`;
    };
    set($('btnMic'), RTC.audioOn, ICON.mic, ICON.micOff, 'microphone');
    set($('btnCam'), RTC.videoOn, ICON.cam, ICON.camOff, 'camera');

    const others = [...S.players.keys()].filter((id) => {
      if (id === S.me?.id) return false;
      const m = mediaOf(id);
      return m.audio || m.video;
    }).length;

    $('callState').textContent = pendingAudio
      ? 'tap to enable sound'
      : others ? `${others} on the call` : '';
    $('callState').classList.toggle('nudge', pendingAudio);
  }

  $('btnMic').onclick = () => toggleMedia('audio');
  $('btnCam').onclick = () => toggleMedia('video');

  if (!RTC.secure) {
    $('rtcNote').textContent = 'Mic and camera need https - open the shared https link.';
    $('btnMic').disabled = $('btnCam').disabled = true;
  }
  renderRoster();

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    Net.send('chat', { text });
    $('chatInput').value = '';
  };

  // ===================================================================
  // go
  // ===================================================================
  /* The top bar cannot hold every control on a 390px phone - they ran off the
   * right edge and Leave became unreachable. So on a phone the board controls
   * move bodily into the panel, which has room, and the bar keeps only the room
   * code, connection and the panel toggle. Moved rather than duplicated so
   * there is only ever one of each button. */
  function placeControls() {
    const group = $('boardControls');
    const target = isSheet() ? $('sheetControls') : $('barControls');
    if (group.parentElement !== target) target.appendChild(group);
  }
  placeControls();
  window.addEventListener('resize', placeControls);
  window.addEventListener('orientationchange', () => setTimeout(placeControls, 250));

  // On a phone the panel is a sheet over the board, so start it closed and let
  // the Players button pull it up.
  if (window.matchMedia('(max-width: 720px)').matches) $('side').classList.add('hidden');
  $('btnSide').classList.toggle('on', !$('side').classList.contains('hidden'));

  // Rotating a phone changes which edge the panel hugs; refit after the reflow.
  window.addEventListener('orientationchange', () => setTimeout(() => { resize(); fitView(); }, 250));

  /* On phones the URL bar shows and hides as you scroll, which changes the
   * visible height without firing a normal resize. visualViewport reports it. */
  if (window.visualViewport) {
    let vvTimer = null;
    window.visualViewport.addEventListener('resize', () => {
      clearTimeout(vvTimer);
      vvTimer = setTimeout(() => { resize(); if (S.ready) fitView(); }, 120);
    });
  }

  /* Android's back button should dismiss whatever is open rather than leaving
   * the game. Opening an overlay pushes a history entry; back consumes it and
   * closes the overlay instead of navigating away. */
  let overlayDepth = 0;
  function pushOverlay() {
    overlayDepth++;
    history.pushState({ jt: 'overlay', depth: overlayDepth }, '');
  }
  function popOverlay() {
    if (overlayDepth > 0) { overlayDepth--; history.back(); }
  }
  window.__jtOverlay = { push: pushOverlay, pop: popOverlay };

  window.addEventListener('popstate', () => {
    if (overlayDepth > 0) overlayDepth--;
    if (!$('leaveConfirm').hidden) { closeLeave(); return; }
    if (isSheet() && panelOpen()) { setPanel(false); return; }
  });
  window.addEventListener('resize', () => { if (S.ready) fitView(); });

  resize();
  requestAnimationFrame(draw);
  Net.connect();
})();
