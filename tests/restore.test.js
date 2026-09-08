/* A game must survive the server restarting.
 *
 * Rooms live in memory, so a redeploy or an idle spin-down wipes them. Every
 * client mirrors the whole board though, so a returning player can hand it
 * back. This kills a real server mid-game and checks the board comes back
 * intact - same code, same assembled pieces, same positions - and that a
 * forged snapshot is refused. */
const WebSocket = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.RESTORE_PORT || 3999);
const URL = `ws://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const fail = (m) => { console.error('FAIL: ' + m); shutdown(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT) }
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
}
function stopServer() { if (server) { try { server.kill(); } catch { /* gone */ } server = null; } }
function shutdown(code) { stopServer(); process.exit(code); }

const health = () => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (x) => {
    let b = ''; x.on('data', (c) => b += c); x.on('end', () => res(b.includes('"ok":true')));
  });
  r.on('error', () => res(false));
  r.on('timeout', () => { r.destroy(); res(false); });
});
async function waitUp() { for (let i = 0; i < 60 && !(await health()); i++) await sleep(250); }
async function waitDown() { for (let i = 0; i < 60 && (await health()); i++) await sleep(250); }

function client(tag) {
  const ws = new WebSocket(URL);
  let opened = false;
  ws.on('open', () => { opened = true; });
  ws.on('error', () => {});
  const seen = [], waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const pending = (t, ms) => new Promise((res, rej) => {
    waiters.push({ type: t, resolve: res });
    setTimeout(() => rej(new Error(tag + ': timeout waiting for ' + t)), ms);
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
  startServer();
  await waitUp();

  // --- play a bit -------------------------------------------------------
  const A = client('A'); await A.open();
  A.send('create', { name: 'Ana', color: '#5865f2' });
  const j = await A.wait('joined');
  const code = j.room.code;
  A.send('setup', { dataUrl: 'data:image/jpeg;base64,AAAA', imageW: 1400, imageH: 933, pieces: 24, title: 'test' });
  const started = await A.wait('started');
  const P = started.room.puzzle;
  const total = P.rows * P.cols;

  // Join two pieces so there is real progress to lose.
  const byId = Object.fromEntries(P.groups.map((g) => [g.id, g]));
  const w = A.next('dropped');
  A.send('grab', { group: 0 });
  A.send('drop', { group: 0, x: byId[1].x, y: byId[1].y });
  const merged = await w;
  if (!merged.merge) fail('setup for the test did not merge');
  console.log(`ok  playing in room ${code}: ${total} pieces, one pair joined`);

  // The client's own copy of the board, exactly as app.js would send it.
  const groups = P.groups
    .filter((g) => !merged.merge.gone.includes(g.id))
    .map((g) => (g.id === merged.merge.keep
      ? { id: g.id, x: merged.merge.x, y: merged.merge.y, p: [0, 1] }
      : { id: g.id, x: g.x, y: g.y, p: g.p }));
  const snapshot = {
    image: { dataUrl: 'data:image/jpeg;base64,AAAA', w: 1400, h: 933, title: 'test' },
    startedAt: started.room.startedAt,
    puzzle: {
      rows: P.rows, cols: P.cols, pieceW: P.pieceW, pieceH: P.pieceH,
      puzzleW: P.puzzleW, puzzleH: P.puzzleH, boardW: P.boardW, boardH: P.boardH,
      originX: P.originX, originY: P.originY, snapTol: P.snapTol, seed: P.seed,
      groups
    }
  };

  // --- kill the server, exactly like a redeploy --------------------------
  A.ws.close();
  stopServer();
  await waitDown();
  console.log('ok  server killed mid-game (every room lost)');

  startServer();
  await waitUp();

  // --- without a snapshot the room is simply gone ------------------------
  {
    const C = client('C'); await C.open();
    C.send('join', { code, name: 'NoSnap', color: '#23a55a' });
    const err = await C.wait('error');
    if (err.code !== 'no-room') fail('expected a no-room error without a snapshot');
    if (!err.restarted) fail('the server should report that it just restarted');
    console.log('ok  a plain rejoin reports the room is gone, and says why');
    C.ws.close();
  }

  // --- a returning player hands the board back ---------------------------
  {
    const B = client('B'); await B.open();
    B.send('join', { code, name: 'Ana', color: '#5865f2', snapshot });
    const back = await B.wait('joined');
    if (back.room.code !== code) fail('restored under a different code');
    const rp = back.room.puzzle;
    if (!rp) fail('the restored room has no puzzle');
    if (rp.rows !== P.rows || rp.cols !== P.cols) fail('restored board has the wrong grid');

    const live = rp.groups.filter((g) => g.p.length > 0);
    const pieceCount = live.reduce((n, g) => n + g.p.length, 0);
    if (pieceCount !== total) fail(`restored board has ${pieceCount} pieces, expected ${total}`);

    const assembly = live.find((g) => g.p.length === 2);
    if (!assembly) fail('the joined pair did not survive the restart');
    if (Math.abs(assembly.x - merged.merge.x) > 0.001 || Math.abs(assembly.y - merged.merge.y) > 0.001) {
      fail('the assembly came back in the wrong place');
    }
    console.log('ok  the board came back: same code, all pieces, the pair still joined and in place');

    // And it is a real room again - a second player can join and play.
    const D = client('D'); await D.open();
    D.send('join', { code, name: 'Ben', color: '#23a55a' });
    const dj = await D.wait('joined');
    if (dj.room.players.length !== 2) fail('the restored room does not accept other players');
    const dw = D.next('dropped');
    D.send('grab', { group: 2 });
    D.send('drop', { group: 2, x: assembly.x, y: assembly.y });
    const d = await dw;
    if (!d.merge) fail('snapping is broken in the restored room');
    console.log('ok  the restored room is fully playable - another player joined and snapped a piece');
    B.ws.close(); D.ws.close();
  }

  // --- a forged snapshot must be refused ---------------------------------
  {
    const bad = [
      ['pieces missing', { ...snapshot, puzzle: { ...snapshot.puzzle, groups: [{ id: 0, x: 0, y: 0, p: [0] }] } }],
      ['piece in two groups', { ...snapshot, puzzle: { ...snapshot.puzzle,
        groups: snapshot.puzzle.groups.concat([{ id: 99, x: 0, y: 0, p: [0] }]) } }],
      ['absurd grid', { ...snapshot, puzzle: { ...snapshot.puzzle, rows: 9999, cols: 9999 } }],
      ['not an image', { ...snapshot, image: { dataUrl: 'javascript:alert(1)', w: 10, h: 10 } }]
    ];
    for (const [label, snap] of bad) {
      const E = client('E'); await E.open();
      E.send('join', { code: 'ZZ' + Math.random().toString(36).slice(2, 4).toUpperCase(), name: 'Bad', color: '#fff', snapshot: snap });
      const r = await E.wait('error', 6000).catch(() => null);
      if (!r || r.code !== 'no-room') fail(`a snapshot with ${label} was accepted`);
      console.log(`ok  refused a snapshot with ${label}`);
      E.ws.close();
      await sleep(80);
    }
  }

  console.log('\nRESTORE TESTS PASSED');
  shutdown(0);
})().catch((e) => fail(e.message));
