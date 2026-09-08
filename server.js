const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const Puzzle = require('./shared/puzzle.js');

const PORT = process.env.PORT || 3000;
const PUZZLE_W = 1200;          // board units across the finished picture
/* How close is close enough to lock. This has to scale with the piece, not be
 * a fixed distance: 26 board units was about 24% of a piece, which on screen
 * is ~14px - near pixel-perfect, and pieces that clearly looked joined would
 * just sit there. Two fifths of the short side is forgiving enough to feel
 * magnetic while still far tighter than the gap to the next piece along. */
const SNAP_FRACTION = 0.4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EMPTY_ROOM_TTL = 1000 * 60 * 30;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const MAX_ROOMS_PER_CONN = 5;
const MAX_PLAYERS = 12;
/* Two budgets. Gameplay is meant to be chatty - dragging, cursors, and picking
 * pieces up and putting them down all burst naturally. Control actions (chat,
 * creating rooms, restarting, peeking) are deliberate human acts and should
 * never arrive dozens of times a second. */
const PLAY_MSGS = new Set(['move', 'cursor', 'grab', 'drop', 'rtc']);
const RATE_FAST = 120;          // gameplay messages per second
const RATE_SLOW = 25;           // everything else per second
// Per-source ceilings. Generous for real play, low enough that a script
// cannot mint rooms or sweep the code space at speed.
const ROOMS_PER_IP_PER_MIN = 20;
const PEEKS_PER_IP_PER_MIN = 300;
// Set only when the proxy sits on a DIFFERENT host; a local tunnel is detected
// automatically (see clientIp).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
// The puzzle model is shared verbatim between server and browser.
app.use('/shared', express.static(path.join(__dirname, 'shared'), { maxAge: 0 }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);

/* Reject websockets opened from another site. Without this any page a player
 * visits could open a socket to this server and act in their name (CSWSH).
 * Requests with no Origin are native clients (our own tests, curl) and are
 * allowed; browsers always send one. Set ALLOWED_ORIGINS to be explicit. */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // not a browser
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (ALLOWED.length) return ALLOWED.includes(origin.toLowerCase()) || ALLOWED.includes(host);
  return host === String(req.headers.host || '').toLowerCase();   // same site
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_IMAGE_BYTES + 1024 * 512,
  verifyClient: ({ req }, done) =>
    originAllowed(req) ? done(true) : done(false, 403, 'Forbidden origin')
});

/** @type {Map<string, Room>} */
const rooms = new Map();

/* Rolling per-minute counters keyed by client address. */
const ipStats = new Map();

const LOOPBACK = /^(::1$|::ffff:127.|127.)/;

/* Behind a tunnel or reverse proxy every player arrives from the proxy's own
 * address, so per-IP quotas would throttle the whole room collectively. The
 * real address is in X-Forwarded-For - but that header is trivially forged, so
 * only believe it when the connection actually came from this machine, which a
 * remote client cannot fake. TRUST_PROXY=1 forces it for a proxy on another
 * host. */
function clientIp(req) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd && (TRUST_PROXY || LOOPBACK.test(direct))) return fwd;
  return direct;
}

function overIpQuota(ip, kind, limit) {
  const now = Date.now();
  let e = ipStats.get(ip);
  if (!e || now - e.at > 60_000) { e = { at: now, rooms: 0, peeks: 0 }; ipStats.set(ip, e); }
  return ++e[kind] > limit;
}

// Don't let the counter map itself become the leak.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipStats) if (now - e.at > 120_000) ipStats.delete(ip);
}, 120_000).unref();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const uid = (() => { let n = 0; return () => `p${++n}${Math.random().toString(36).slice(2, 6)}`; })();

// Kept in step with COLORS in public/js/app.js.
const PALETTE = ['#5865f2', '#23a55a', '#f0b132', '#f23f43', '#eb459f',
  '#00a8fc', '#f47b67', '#9b59f6', '#1abc9c', '#e67e22'];

/* Two people in the same colour makes cursors and held pieces unreadable, so
 * the room is the authority: take the wanted colour if it's free, else the
 * first unused one, else anything. */
function pickColour(room, wanted) {
  const taken = new Set([...room.players.values()].map((p) => String(p.color).toLowerCase()));
  // Coerce FIRST. An Array like ['#ffffff'] stringifies straight past the
  // regex and then has no .toLowerCase(), which used to throw and, being
  // uncaught inside a socket handler, took the whole process down.
  const asked = String(wanted == null ? '' : wanted).toLowerCase();
  const ok = /^#[0-9a-f]{6}$/.test(asked) ? asked : null;
  if (ok && !taken.has(ok)) return ok;
  return PALETTE.find((c) => !taken.has(c)) || ok || PALETTE[0];
}

function makeRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(),
    image: null,          // { dataUrl, w, h }
    state: null,          // live puzzle, null until the host starts
    chat: [],
    startedAt: null,
    solvedAt: null,
    emptySince: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}

/* Cut the picture into pieces and lay them out.
 *
 * Pieces land in a tidy, non-overlapping tray ringing the board rather than in a
 * random heap. A heap looks busy and buries half the pieces under the other
 * half; on a grid every piece is visible and grabbable from the first second,
 * and the middle stays clear to build in. */
function buildState(room, imageW, imageH, targetPieces) {
  const { rows, cols } = Puzzle.chooseGrid(targetPieces, imageW, imageH);
  const puzzleH = PUZZLE_W * (imageH / imageW);
  const pieceW = PUZZLE_W / cols;
  const pieceH = puzzleH / rows;
  const total = rows * cols;

  const seed = (Math.random() * 0xffffffff) >>> 0;
  const rnd = Puzzle.makeRng(seed ^ 0x9e3779b9);

  /* One tray cell per piece. The gap has to be wider than the snap tolerance,
   * or two pieces that happen to be neighbours would be close enough to lock
   * while they are just sitting in the tray waiting to be picked up. */
  const CELL = 1 + SNAP_FRACTION + 0.08;      // tolerance, plus clearance
  const cellW = pieceW * CELL;
  const cellH = pieceH * CELL;

  /* The tray is a ring around the picture rather than two side columns. Side
   * columns alone would make the board three or four times wider than tall, and
   * fitting that to a screen shrinks every piece. A ring keeps the board close
   * to the picture's own proportions, so pieces stay big. Widen the band until
   * every piece has its own cell. */
  let band = 1.5, boardW = 0, boardH = 0, originX = 0, originY = 0, slots = [];
  for (; band <= 10; band += 0.25) {
    const bw = band * cellW, bh = band * cellH;
    boardW = PUZZLE_W + bw * 2;
    boardH = puzzleH + bh * 2;
    originX = bw;
    originY = bh;

    const nx = Math.max(1, Math.floor(boardW / cellW));
    const ny = Math.max(1, Math.floor(boardH / cellH));
    const offX = (boardW - nx * cellW) / 2;
    const offY = (boardH - ny * cellH) / 2;

    slots = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = offX + (i + 0.5) * cellW;
        const cy = offY + (j + 0.5) * cellH;
        // Keep the middle clear: skip any cell sitting over the picture.
        const inPicture =
          cx > originX - cellW * 0.15 && cx < originX + PUZZLE_W + cellW * 0.15 &&
          cy > originY - cellH * 0.15 && cy < originY + puzzleH + cellH * 0.15;
        if (inPicture) continue;
        slots.push({ x: cx - pieceW / 2, y: cy - pieceH / 2 });
      }
    }
    if (slots.length >= total) break;
  }

  for (let i = slots.length - 1; i > 0; i--) {           // Fisher-Yates
    const j = Math.floor(rnd() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  const pieces = [];
  const groups = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      pieces.push({ id, row: r, col: c, group: id });
      const slot = slots[id] || { x: rnd() * boardW, y: rnd() * boardH };
      groups[id] = {
        id, parent: null, pieces: [id],
        // group translation: piece world pos = (x + col*pieceW, y + row*pieceH)
        x: slot.x - c * pieceW,
        y: slot.y - r * pieceH,
        heldBy: null, z: id
      };
    }
  }

  room.state = {
    rows, cols, pieceW, pieceH, puzzleW: PUZZLE_W, puzzleH,
    boardW, boardH, originX, originY, seed,
    snapTol: Math.min(pieceW, pieceH) * SNAP_FRACTION,
    pieces, groups, zTop: total
  };
  room.startedAt = Date.now();
  room.solvedAt = null;
}

/* A hold is only meant to last as long as a drag. If a player's browser is
 * killed mid-drag, or a drop is lost, the piece would stay locked to them until
 * they disconnect - and nobody else could touch it. Anything held this long
 * without movement is treated as abandoned. */
const HOLD_TIMEOUT = Number(process.env.HOLD_TIMEOUT_MS || 20_000);

function sweepStaleHolds(room) {
  const st = room.state;
  if (!st) return;
  const now = Date.now();
  for (const g of Object.values(st.groups)) {
    if (g.heldBy && g.heldAt && now - g.heldAt > HOLD_TIMEOUT) {
      g.heldBy = null;
      g.heldAt = 0;
      broadcast(room, 'released', { group: g.id });
    }
  }
}

/* Only live (unmerged) groups need to cross the wire. */
function serializeGroups(state) {
  const out = [];
  for (const g of Object.values(state.groups)) {
    if (g.parent === null) out.push({ id: g.id, x: g.x, y: g.y, p: g.pieces, h: g.heldBy, z: g.z });
  }
  return out;
}

const playerInfo = (p) => ({
  id: p.id, name: p.name, color: p.color, cursor: p.cursor,
  media: p.media || { audio: false, video: false }
});

function roomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: [...room.players.values()].map(playerInfo),
    image: room.image,
    chat: room.chat.slice(-40),
    startedAt: room.startedAt,
    solvedAt: room.solvedAt,
    puzzle: room.state && {
      rows: room.state.rows, cols: room.state.cols,
      pieceW: room.state.pieceW, pieceH: room.state.pieceH,
      puzzleW: room.state.puzzleW, puzzleH: room.state.puzzleH,
      boardW: room.state.boardW, boardH: room.state.boardH,
      originX: room.state.originX, originY: room.state.originY,
      snapTol: room.state.snapTol,
      seed: room.state.seed,
      groups: serializeGroups(room.state)
    }
  };
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function broadcast(room, type, data, exceptId) {
  const msg = JSON.stringify({ type, ...data });
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

// Strip control characters, keep everything a human would actually type.
const clean = (s, max) =>
  String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  let player = null;
  let room = null;
  let roomsMade = 0;
  const bucket = { at: 0, fast: 0, slow: 0 };

  /* Simple per-second token bucket. Dropping is the right response here: a
   * lost cursor update is invisible, and a client flooding us is not one we
   * owe a reply to. */
  function overRate(type) {
    const now = Date.now();
    if (now - bucket.at > 1000) { bucket.at = now; bucket.fast = 0; bucket.slow = 0; }
    if (PLAY_MSGS.has(type)) return ++bucket.fast > RATE_FAST;
    return ++bucket.slow > RATE_SLOW;
  }

  ws.on('message', (raw) => {
   // One malformed message must never be able to take the server down.
   try {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (overRate(msg.type)) return;

    /* Round-trip probe. Echoed as-is so the client can measure its own
     * latency without the server keeping any per-client timing state. */
    if (msg.type === 'ping') return send(ws, 'pong', { t: msg.t });

    /* Look at a room from the lobby without entering it, so the join screen can
     * show who is already there and which colours are still free. */
    if (msg.type === 'peek') {
      if (overIpQuota(ip, 'peeks', PEEKS_PER_IP_PER_MIN)) return;
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, 'peek', { code, found: false });
      return send(ws, 'peek', {
        code,
        found: true,
        full: r.players.size >= MAX_PLAYERS,
        started: !!r.state,
        pieces: r.state ? r.state.rows * r.state.cols : null,
        picture: r.image ? r.image.title : null,
        players: [...r.players.values()].map((p) => ({ name: p.name, color: p.color }))
      });
    }

    // --- lobby ------------------------------------------------------------
    if (msg.type === 'create' || msg.type === 'join') {
      if (player) return;
      if (msg.type === 'create') {
        if (rooms.size >= MAX_ROOMS) {
          return send(ws, 'error', { message: 'The server is at capacity, try again shortly.' });
        }
        if (++roomsMade > MAX_ROOMS_PER_CONN ||
            overIpQuota(ip, 'rooms', ROOMS_PER_IP_PER_MIN)) {
          return send(ws, 'error', { message: 'Too many rooms created just now. Wait a minute.' });
        }
        room = makeRoom();
      } else {
        room = rooms.get(clean(msg.code, 8).toUpperCase());
        if (!room) return send(ws, 'error', { message: 'No room with that code.' });
        if (room.players.size >= MAX_PLAYERS) return send(ws, 'error', { message: 'That room is full.' });
      }
      player = {
        id: uid(),
        name: clean(msg.name, 20) || 'Player',
        color: pickColour(room, msg.color),
        cursor: null,
        media: { audio: false, video: false },
        ws
      };
      room.players.set(player.id, player);
      room.emptySince = null;
      if (!room.hostId) room.hostId = player.id;
      send(ws, 'joined', { you: playerInfo(player), room: roomSnapshot(room) });
      broadcast(room, 'playerJoined', { player: playerInfo(player) }, player.id);
      return;
    }

    if (!player || !room) return;
    const st = room.state;

    switch (msg.type) {
      // --- host sets the picture and cuts it ------------------------------
      case 'setup': {
        if (player.id !== room.hostId) return;
        const url = String(msg.dataUrl || '');
        const inlineBytes = url.startsWith('data:image/');
        const remote = /^https?:\/\//i.test(url);
        if ((!inlineBytes && !remote) || url.length > MAX_IMAGE_BYTES) {
          return send(ws, 'error', { message: 'That image could not be used.' });
        }
        const w = Math.max(1, Math.min(8000, msg.imageW | 0));
        const h = Math.max(1, Math.min(8000, msg.imageH | 0));
        room.image = { dataUrl: url, w, h, title: clean(msg.title, 40) || 'Custom image' };
        buildState(room, w, h, Math.max(6, Math.min(1000, (msg.pieces | 0) || 48)));
        broadcast(room, 'started', { room: roomSnapshot(room) });
        return;
      }

      // --- board interaction ----------------------------------------------
      case 'grab': {
        if (!st) return;
        sweepStaleHolds(room);
        const g = st.groups[msg.group];
        if (!g || g.parent !== null) return;
        if (g.heldBy && g.heldBy !== player.id) return send(ws, 'grabDenied', { group: g.id });
        g.heldBy = player.id;
        g.heldAt = Date.now();
        g.z = ++st.zTop;
        broadcast(room, 'grabbed', { group: g.id, by: player.id, z: g.z });
        return;
      }

      case 'move': {
        if (!st) return;
        const g = st.groups[msg.group];
        if (!g || g.parent !== null || g.heldBy !== player.id) return;
        g.x = +msg.x || 0;
        g.y = +msg.y || 0;
        g.heldAt = Date.now();          // still being dragged, so still fresh
        broadcast(room, 'moved', { group: g.id, x: g.x, y: g.y }, player.id);
        return;
      }

      case 'drop': {
        if (!st) return;
        const g = st.groups[msg.group];
        if (!g || g.parent !== null || g.heldBy !== player.id) return;
        g.x = +msg.x || 0;
        g.y = +msg.y || 0;
        g.heldBy = null;
        g.heldAt = 0;

        // Server is the referee on snapping so nobody's board drifts.
        const before = Puzzle.findRoot(st.groups, g.id).id;
        const gone = Puzzle.resolveSnaps(st, g.id, st.snapTol);
        const keep = Puzzle.findRoot(st.groups, g.id);
        if (gone.length) { keep.z = ++st.zTop; keep.heldBy = null; }

        if (Puzzle.isSolved(st) && !room.solvedAt) room.solvedAt = Date.now();

        const payload = {
          group: g.id, x: g.x, y: g.y, by: player.id,
          merge: gone.length
            ? { keep: keep.id, x: keep.x, y: keep.y, z: keep.z, gone, from: before }
            : null,
          solved: room.solvedAt
        };
        broadcast(room, 'dropped', payload);
        return;
      }

      case 'cursor': {
        player.cursor = { x: +msg.x || 0, y: +msg.y || 0 };
        broadcast(room, 'cursor', { id: player.id, x: player.cursor.x, y: player.cursor.y }, player.id);
        return;
      }

      /* WebRTC signalling. The server never sees audio or video - it only
       * forwards offers, answers and ICE candidates between two players in the
       * same room so their browsers can connect to each other directly. */
      case 'rtc': {
        const to = room.players.get(String(msg.to || ''));
        if (!to) return;
        send(to.ws, 'rtc', { from: player.id, kind: msg.kind, payload: msg.payload });
        return;
      }

      /* Who has a mic on, who has a camera on. Tracked per player so somebody
       * joining halfway through immediately sees the state of the call. */
      case 'rtcState': {
        player.media = { audio: !!msg.audio, video: !!msg.video };
        broadcast(room, 'rtcState', {
          id: player.id, audio: player.media.audio, video: player.media.video
        }, player.id);
        return;
      }

      case 'chat': {
        const text = clean(msg.text, 240);
        if (!text) return;
        const entry = { id: player.id, name: player.name, color: player.color, text, at: Date.now() };
        room.chat.push(entry);
        if (room.chat.length > 200) room.chat.shift();
        broadcast(room, 'chat', { entry });
        return;
      }

      case 'restart': {
        if (player.id !== room.hostId || !room.image) return;
        const count = (msg.pieces | 0) || (st ? st.rows * st.cols : 48);
        buildState(room, room.image.w, room.image.h, Math.max(6, Math.min(1000, count)));
        broadcast(room, 'started', { room: roomSnapshot(room) });
        return;
      }
    }
   } catch (err) {
     console.error('message handler error:', err && err.message);
   }
  });

  ws.on('close', () => {
    if (!player || !room) return;
    player.media = { audio: false, video: false };
    room.players.delete(player.id);
    // Never strand a piece under a player who left.
    if (room.state) {
      for (const g of Object.values(room.state.groups)) {
        if (g.heldBy === player.id) { g.heldBy = null; broadcast(room, 'released', { group: g.id }); }
      }
    }
    if (room.hostId === player.id) {
      room.hostId = room.players.keys().next().value || null;
      if (room.hostId) broadcast(room, 'host', { hostId: room.hostId });
    }
    broadcast(room, 'playerLeft', { id: player.id });
    if (room.players.size === 0) room.emptySince = Date.now();
  });
});

// Reap rooms nobody came back to.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) {
      rooms.delete(code);
    }
  }
}, 60_000).unref();

/* A game server losing one room is far better than losing every room. Log
 * loudly, but do not let a stray throw end the process for everyone. */
process.on('uncaughtException', (err) => console.error('uncaught:', err && err.stack));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

server.listen(PORT, () => console.log(`Jigsaw Together on http://localhost:${PORT}`));
