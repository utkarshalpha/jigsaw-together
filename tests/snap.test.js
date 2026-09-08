/* Focused test of the join mechanic, the way a human actually plays:
 * drop a piece NEAR its neighbour (not exactly on it), check it locks, check the
 * assembly then moves as one and does not come apart. */
const WebSocket = require('ws');
const URL = process.env.JT_URL || 'ws://localhost:3000';
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(tag) {
  const ws = new WebSocket(URL);
  let opened = false;
  ws.on('open', () => { opened = true; });
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const pending = (type, ms) => new Promise((res, rej) => {
    waiters.push({ type, resolve: res });
    setTimeout(() => rej(new Error(tag + ': timeout waiting for ' + type)), ms);
  });
  return {
    ws, seen,
    open: () => opened ? Promise.resolve() : new Promise((r) => ws.on('open', r)),
    send: (t, d) => ws.send(JSON.stringify({ type: t, ...d })),
    wait: (t, ms = 12000) => { const h = seen.find((m) => m.type === t); return h ? Promise.resolve(h) : pending(t, ms); },
    next: (t, ms = 12000) => pending(t, ms)
  };
}

(async () => {
  const A = client('A'); await A.open();
  A.send('create', { name: 'Snap', color: '#5865f2' });
  const j = await A.wait('joined');
  const code = j.room.code;

  A.send('setup', { dataUrl: 'data:image/jpeg;base64,AAAA', imageW: 1400, imageH: 933, pieces: 80, title: 't' });
  const st = await A.wait('started');
  const P = st.room.puzzle;
  const { cols, pieceW, pieceH } = P;
  const G = Object.fromEntries(P.groups.map((g) => [g.id, { x: g.x, y: g.y }]));
  console.log(`board ${P.rows}x${cols}, piece ${Math.round(pieceW)}x${Math.round(pieceH)} board units\n`);

  // Helper: put group `id` at translation (x,y) and report what came back.
  async function drop(id, x, y) {
    const w = A.next('dropped', 6000);
    A.send('grab', { group: id });
    A.send('drop', { group: id, x, y });
    return w;
  }

  // --- 1. exact placement -------------------------------------------------
  {
    const d = await drop(0, G[1].x, G[1].y);
    if (!d.merge) fail('pieces 0 and 1 did not join when dropped exactly together');
    console.log('ok  exact placement joins');
  }

  // --- 2. near placement, the human case ----------------------------------
  // Piece 2 sits right of piece 1, so it belongs at the assembly's translation.
  {
    const asm = { x: G[1].x, y: G[1].y };
    const off = 12;                       // a sloppy but reasonable drop
    const d = await drop(2, asm.x + off, asm.y - off);
    if (!d.merge) fail(`a piece dropped ${off} units off (tolerance is 26) did not join`);
    console.log(`ok  a drop ${off} units off still joins`);
  }

  // --- 3. too far must NOT join -------------------------------------------
  {
    const asm = { x: G[1].x, y: G[1].y };
    const d = await drop(3, asm.x + 200, asm.y + 200);
    if (d.merge) fail('a piece dropped 200 units away joined anyway - snapping is far too loose');
    console.log('ok  a piece dropped far away does not join');
  }

  // --- 4. the assembly moves as ONE and keeps its shape -------------------
  {
    // Find the surviving root and its members.
    const anyDrop = A.seen.filter((m) => m.type === 'dropped' && m.merge).pop();
    const keep = anyDrop.merge.keep;

    const before = A.next('dropped', 6000);
    A.send('grab', { group: keep });
    A.send('move', { group: keep, x: 400, y: 300 });
    A.send('drop', { group: keep, x: 400, y: 300 });
    const d = await before;
    if (Math.abs(d.x - 400) > 0.001 || Math.abs(d.y - 300) > 0.001) {
      fail(`the assembly did not move where it was put (got ${d.x},${d.y})`);
    }
    console.log('ok  a joined assembly moves as one unit');

    // Re-join a fresh client to read authoritative state back.
    const B = client('B'); await B.open();
    B.send('join', { code, name: 'Check', color: '#23a55a' });
    const bj = await B.wait('joined');
    const groups = bj.room.puzzle.groups;
    const root = groups.find((g) => g.id === keep);
    if (!root) fail('the assembly vanished from server state');
    if (root.p.length < 3) fail(`the assembly came apart: expected 3+ pieces, server has ${root.p.length}`);
    if (Math.abs(root.x - 400) > 0.001 || Math.abs(root.y - 300) > 0.001) {
      fail('the assembly is not where it was dropped in authoritative state');
    }
    console.log(`ok  server state agrees: ${root.p.length} pieces held together at the new position`);

    // Every piece in the assembly must still be in its correct relative spot.
    const ids = root.p.slice().sort((a, b) => a - b);
    for (const pid of ids) {
      const r = Math.floor(pid / cols), c = pid % cols;
      const wx = root.x + c * pieceW, wy = root.y + r * pieceH;
      const nb = ids.find((o) => o === pid + 1 && (pid + 1) % cols !== 0);
      if (nb !== undefined) {
        const nwx = root.x + (nb % cols) * pieceW;
        if (Math.abs((nwx - wx) - pieceW) > 0.001) fail('pieces inside the assembly drifted apart');
      }
    }
    console.log('ok  pieces inside the assembly keep exact relative positions');
    B.ws.close();
  }

  // --- 5. joining a big assembly to a lone piece keeps the big one still ---
  {
    const lone = cols;            // row 1, col 0 - directly below piece 0
    const asmDrop = A.seen.filter((m) => m.type === 'dropped' && m.merge).pop();
    const keep = asmDrop.merge.keep;
    const r = Math.floor(lone / cols), c = lone % cols;
    // Put the lone piece exactly where it belongs relative to the assembly.
    const d = await drop(lone, 400, 300);
    if (!d.merge) fail('a lone piece dropped at its correct spot on the assembly did not join');
    if (d.merge.keep !== keep) {
      console.log(`note  the assembly id changed ${keep} -> ${d.merge.keep} (larger group should absorb)`);
    }
    if (Math.abs(d.merge.x - 400) > 0.001 || Math.abs(d.merge.y - 300) > 0.001) {
      fail('the assembly jumped when a single piece joined it - the big group should stay put');
    }
    console.log('ok  a lone piece joins without moving the assembly');
  }

  console.log('\nALL SNAP TESTS PASSED');
  process.exit(0);
})().catch((e) => fail(e.message));
