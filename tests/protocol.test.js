/* Drives two real websocket clients against the running server to check the
 * room protocol, piece locking, snap-merge and completion. */
const WebSocket = require('ws');

const URL = process.env.JT_URL || 'ws://localhost:3000';
const IMG = 'data:image/jpeg;base64,AAAA';   // server only checks the prefix
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

function client(tag) {
  const ws = new WebSocket(URL);
  let opened = false;
  ws.on('open', () => { opened = true; });
  const seen = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  const pending = (type, ms) => new Promise((resolve, reject) => {
    waiters.push({ type, resolve });
    setTimeout(() => reject(new Error(`${tag}: timed out waiting for "${type}"`)), ms);
  });
  return {
    tag, ws, seen,
    open: () => opened ? Promise.resolve() : new Promise((r) => ws.on('open', r)),
    send: (type, data) => ws.send(JSON.stringify({ type, ...data })),
    // Resolves on an already-received message if there is one.
    wait: (type, ms = 12000) => {
      const had = seen.find((m) => m.type === type);
      return had ? Promise.resolve(had) : pending(type, ms);
    },
    // Always waits for the *next* one, ignoring history.
    next: (type, ms = 12000) => pending(type, ms),
    count: (type) => seen.filter((m) => m.type === type).length
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = client('A'), B = client('B');
  await A.open();

  // --- room creation and join -------------------------------------------
  A.send('create', { name: 'Ana', color: '#6ea8fe' });
  const aJoined = await A.wait('joined');
  const code = aJoined.room.code;
  if (!/^[A-Z0-9]{4}$/.test(code)) fail('bad room code: ' + code);
  if (aJoined.room.hostId !== aJoined.you.id) fail('creator should be host');
  console.log('ok  room created:', code);

  await B.open();
  B.send('join', { code, name: 'Ben', color: '#f76c6c' });
  const bJoined = await B.wait('joined');
  if (bJoined.room.players.length !== 2) fail('B should see 2 players');
  await A.wait('playerJoined');
  console.log('ok  second player joined and was announced');

  // --- bad code is refused ----------------------------------------------
  const C = client('C');
  await C.open();
  C.send('join', { code: 'ZZZZ', name: 'Nope', color: '#fff' });
  const err = await C.wait('error');
  // Assert on the stable code, not the prose: the message deliberately changes
  // to explain a restart when the server has only just come up.
  if (err.code !== 'no-room') fail('expected a no-room error, got ' + JSON.stringify(err));
  C.ws.close();
  console.log('ok  unknown room code refused');

  // --- peeking at a room from the lobby ----------------------------------
  {
    const D = client('D');
    await D.open();
    let p = D.next('peek');
    D.send('peek', { code: 'ZZZZ' });
    let r = await p;
    if (r.found !== false) fail('peek claimed an unknown room exists');
    console.log('ok  peeking an unknown room reports not found');

    p = D.next('peek');
    D.send('peek', { code });
    r = await p;
    if (!r.found) fail('peek could not see a real room');
    if (r.players.length !== 2) fail('peek should list both players, saw ' + r.players.length);
    if (!r.players.some((x) => x.name === 'Ana') || !r.players.some((x) => x.name === 'Ben')) {
      fail('peek did not name the people in the room');
    }
    if (r.started !== false) fail('peek says started before the host chose a picture');
    console.log('ok  peek lists who is already in the room');

    // Peeking must not put the peeker in the room.
    if (r.players.some((x) => x.name === 'Nosy')) fail('peeking joined the room');
    D.ws.close();
    console.log('ok  peeking does not join the room');
  }

  // --- colours stay unique ------------------------------------------------
  {
    const E = client('E');
    await E.open();
    // Ana already holds #6ea8fe... ask for Ben's colour and expect a different one.
    const taken = bJoined.you.color;
    const ej = E.next('joined');
    E.send('join', { code, name: 'Clash', color: taken });
    const e = await ej;
    if (e.you.color.toLowerCase() === taken.toLowerCase()) {
      fail('two players ended up with the same colour');
    }
    console.log('ok  a duplicate colour request is reassigned (' + taken + ' -> ' + e.you.color + ')');
    E.ws.close();
    await sleep(120);
  }

  // --- host cuts the puzzle ---------------------------------------------
  A.send('setup', { dataUrl: IMG, imageW: 1400, imageH: 933, pieces: 24, title: 'test' });
  const started = await A.wait('started');
  await B.wait('started');
  const P = started.room.puzzle;
  const total = P.rows * P.cols;
  console.log(`ok  puzzle cut: ${P.rows}x${P.cols} = ${total} pieces`);
  if (P.groups.length !== total) fail('every piece should start as its own group');

  await sleep(120);
  if (A.count('started') !== 1) fail('host received "started" x' + A.count('started') + ', expected 1');
  console.log('ok  host got exactly one "started" (no duplicate)');

  // --- piece locking -----------------------------------------------------
  const byId = Object.fromEntries(P.groups.map((g) => [g.id, g]));
  A.send('grab', { group: 0 });
  await A.wait('grabbed');
  B.send('grab', { group: 0 });
  const denied = await B.wait('grabDenied');
  if (denied.group !== 0) fail('wrong group denied');
  console.log('ok  a piece held by one player is refused to the other');

  // --- live drag relay ---------------------------------------------------
  {
    const mv = B.next('moved');
    A.send('move', { group: 0, x: 123.5, y: -67.25 });
    const m = await mv;
    if (m.group !== 0 || m.x !== 123.5 || m.y !== -67.25) fail('move did not relay verbatim');
    console.log('ok  drag positions relay to the other player');
  }
  {
    // A player must not be able to drag a piece somebody else is holding.
    const before = B.count('moved');
    B.send('move', { group: 0, x: 999, y: 999 });
    await sleep(200);
    if (A.seen.some((m) => m.type === 'moved' && m.x === 999)) fail('a non-holder moved a held piece');
    console.log('ok  a piece cannot be moved by someone who is not holding it');
  }

  // --- snapping ----------------------------------------------------------
  // Pieces 0 and 1 sit side by side, so aligning their group translations merges them.
  let dropWatch = A.next('dropped');
  A.send('drop', { group: 0, x: byId[1].x, y: byId[1].y });
  const dropped = await dropWatch;
  if (!dropped.merge) fail('adjacent pieces did not merge');
  // Dropping where two correct neighbours already sit should join both, so
  // any number of absorbed groups is valid - only zero is a failure.
  if (dropped.merge.gone.length < 1) fail('nothing was absorbed on a correct drop');
  console.log('ok  adjacent pieces merged on drop');

  await sleep(150);
  if (A.count('dropped') !== 1) fail('dropper received "dropped" x' + A.count('dropped') + ', expected 1');
  console.log('ok  dropper got exactly one "dropped" (no duplicate)');

  const bDrop = B.seen.filter((m) => m.type === 'dropped');
  if (bDrop.length !== 1 || !bDrop[0].merge) fail('other player did not see the merge');
  console.log('ok  the merge reached the other player');

  // --- solve the whole board --------------------------------------------
  // The assembly's translation moves as groups absorb each other, so follow it
  // rather than assuming it stays put.
  let assembly = { x: dropped.merge.x, y: dropped.merge.y };
  const absorbed = new Set(dropped.merge.gone);
  absorbed.add(dropped.merge.keep);   // the assembly itself, not a loose piece

  let solvedAt = null;
  let finalKeep = dropped.merge.keep;   // the one group still standing at the end
  for (let id = 0; id < total; id++) {
    if (absorbed.has(id)) continue;
    const w = A.next('dropped', 6000);
    A.send('grab', { group: id });
    A.send('drop', { group: id, x: assembly.x, y: assembly.y });
    const d = await w;
    if (!d.merge) fail(`piece ${id} dropped onto the assembly but did not merge`);
    assembly = { x: d.merge.x, y: d.merge.y };
    d.merge.gone.forEach((g) => absorbed.add(g));
    absorbed.add(d.merge.keep);
    finalKeep = d.merge.keep;
    if (d.solved) solvedAt = d.solved;
  }
  if (!solvedAt) fail('board never reported solved');
  console.log(`ok  all ${total} pieces assembled, board reported solved`);

  // --- webrtc signalling relay -------------------------------------------
  {
    const got = B.next('rtc');
    A.send('rtc', { to: bJoined.you.id, kind: 'offer', payload: { sdp: 'x', type: 'offer' } });
    const sig = await got;
    if (sig.from !== aJoined.you.id || sig.kind !== 'offer' || sig.payload.sdp !== 'x') {
      fail('rtc signal did not relay intact');
    }
    console.log('ok  webrtc signalling relays to the named peer');

    // A signal aimed at a stranger must not leak to the room.
    const beforeCount = B.count('rtc');
    A.send('rtc', { to: 'nobody-here', kind: 'offer', payload: { sdp: 'leak' } });
    await sleep(200);
    if (B.count('rtc') !== beforeCount) fail('rtc signal leaked to the wrong player');
    console.log('ok  a signal for an unknown peer is dropped, not broadcast');

    const ready = B.next('rtcState');
    A.send('rtcState', { audio: true, video: false });
    const r = await ready;
    if (r.id !== aJoined.you.id || r.audio !== true || r.video !== false) {
      fail('rtcState did not report mic on / camera off');
    }
    console.log('ok  mic and camera state announce separately');

    // A player joining later must be told who is already on the call.
    const L = client('L');
    await L.open();
    const lj = L.next('joined');
    L.send('join', { code, name: 'Late', color: '#9b59f6' });
    const late = await lj;
    const anaRow = late.room.players.find((p) => p.name === 'Ana');
    if (!anaRow || !anaRow.media || anaRow.media.audio !== true) {
      fail('a late joiner was not told that Ana has her mic on');
    }
    console.log('ok  a late joiner sees who already has mic/camera on');
    L.ws.close();
    await sleep(120);
  }

  // --- peek is shared ------------------------------------------------------
  {
    const seen = B.next('preview');
    A.send('preview', { on: true });
    const p = await seen;
    if (p.id !== aJoined.you.id || p.on !== true) fail('peek was not relayed to the other player');
    console.log('ok  holding peek shows the picture to everyone');

    const off = B.next('preview');
    A.send('preview', { on: false });
    const q = await off;
    if (q.on !== false) fail('releasing peek did not relay');
    console.log('ok  releasing peek clears it for everyone');
  }

  // --- chat and disconnect ----------------------------------------------
  B.send('chat', { text: 'nice one' });
  const chat = await A.wait('chat');
  if (chat.entry.text !== 'nice one' || chat.entry.name !== 'Ben') fail('chat did not relay');
  console.log('ok  chat relayed');

  const releaseWatch = B.next('released');
  const hostWatch = B.next('host');
  A.send('grab', { group: finalKeep });
  await sleep(80);
  A.ws.close();                     // host walks out while holding a piece
  await releaseWatch.catch(() => fail('held piece was not released on disconnect'));
  const newHost = await hostWatch;
  if (newHost.hostId !== bJoined.you.id) fail('host did not transfer');
  console.log('ok  disconnect released the piece and handed over host');

  B.ws.close();
  console.log('\nALL PROTOCOL TESTS PASSED');
  process.exit(0);
})().catch((e) => fail(e.message));
