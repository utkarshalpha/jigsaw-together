/* A piece held by a player whose drag was interrupted must not stay locked
 * forever. Uses a shortened timeout via HOLD_TIMEOUT_MS so the test is quick. */
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
  const A = client('A'); await A.open();
  A.send('create', { name: 'Ana', color: '#5865f2' });
  const j = await A.wait('joined');
  const code = j.room.code;
  A.send('setup', { dataUrl: 'data:image/jpeg;base64,AAAA', imageW: 1400, imageH: 933, pieces: 80, title: 't' });
  await A.wait('started');

  const B = client('B'); await B.open();
  B.send('join', { code, name: 'Ben', color: '#23a55a' });
  await B.wait('joined');

  // A grabs a piece and then vanishes mid-drag (no drop is ever sent).
  A.send('grab', { group: 0 });
  await B.wait('grabbed');
  console.log('ok  A holds piece 0 and never drops it');

  // Straight away, B must not be able to take it.
  B.send('grab', { group: 0 });
  const denied = await B.next('grabDenied', 3000).catch(() => null);
  if (!denied) fail('a freshly held piece was handed to someone else');
  console.log('ok  while the hold is fresh, nobody else can take the piece');

  const timeout = Number(process.env.HOLD_TIMEOUT_MS || 20000);
  console.log(`    waiting ${Math.round(timeout / 1000)}s for the hold to go stale...`);
  await sleep(timeout + 1200);

  // Now B's grab should sweep the stale hold and succeed.
  const released = B.next('released', 4000).catch(() => null);
  const got = B.next('grabbed', 4000).catch(() => null);
  B.send('grab', { group: 0 });
  const r = await released;
  const g = await got;
  if (!r) fail('the abandoned hold was never released');
  if (!g || g.by !== (await B.wait('joined')).you.id) fail('B could not pick up the abandoned piece');
  console.log('ok  an abandoned hold is released and the piece becomes grabbable again');

  A.ws.close(); B.ws.close();
  console.log('\nHOLD TESTS PASSED');
  process.exit(0);
})().catch((e) => fail(e.message));
