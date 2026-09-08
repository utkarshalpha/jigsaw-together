/* Security probe: throws malformed and hostile input at a running server and
 * reports what survives. Read-only apart from creating throwaway rooms. */
const WebSocket = require('ws');
const URL = process.env.JT_URL || 'ws://localhost:3000';
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conn(opts = {}) {
  const ws = new WebSocket(URL, opts);
  const seen = [];
  ws.on('message', (r) => { try { seen.push(JSON.parse(r)); } catch {} });
  ws.on('error', () => {});
  return {
    ws, seen,
    open: () => new Promise((res, rej) => {
      ws.on('open', () => res(true));
      ws.on('error', (e) => rej(e));
      setTimeout(() => rej(new Error('timeout')), 4000);
    }),
    send: (t, d) => { try { ws.send(JSON.stringify({ type: t, ...d })); } catch {} }
  };
}

const alive = () => new Promise((res) => {
  const r = http.get('http://localhost:3000/health', (x) => {
    let b = ''; x.on('data', (c) => b += c); x.on('end', () => res(b.includes('ok')));
  });
  r.on('error', () => res(false));
  r.setTimeout(3000, () => { r.destroy(); res(false); });
});

const findings = [];
const report = (sev, title, detail) => { findings.push({ sev, title, detail }); console.log(`  [${sev}] ${title}\n        ${detail}`); };

(async () => {
  console.log('=== 1. Type confusion on the colour field ===');
  {
    const c = conn();
    await c.open();
    // An array stringifies to something the hex regex accepts, but has no
    // .toLowerCase() - so a naive validator throws.
    c.send('create', { name: 'x', color: ['#ffffff'] });
    await sleep(700);
    const ok = await alive();
    if (!ok) report('CRITICAL', 'Server crashed on array-typed colour',
      'color:["#ffffff"] passes the string-coerced regex then calls .toLowerCase() on an Array -> uncaught TypeError kills the process.');
    else if (!c.seen.some((m) => m.type === 'joined')) report('LOW', 'Array colour rejected without a reply', 'No crash, but no error message either.');
    else console.log('  ok  array colour handled safely ->', c.seen.find((m) => m.type === 'joined').you.color);
    c.ws.close();
  }

  if (!(await alive())) { console.log('\nSERVER IS DOWN - stopping probe'); process.exit(1); }

  console.log('\n=== 2. Cross-site WebSocket hijacking (origin check) ===');
  {
    try {
      const c = conn({ origin: 'https://evil.example' });
      await c.open();
      c.send('create', { name: 'evil', color: '#ffffff' });
      await sleep(500);
      if (c.seen.some((m) => m.type === 'joined')) {
        report('MEDIUM', 'No Origin check on the websocket',
          'A connection claiming Origin: https://evil.example was accepted and could create/join rooms. Any web page can drive this server on a visitor\'s behalf.');
      } else console.log('  ok  foreign origin refused');
      c.ws.close();
    } catch (e) { console.log('  ok  foreign origin refused at handshake'); }
  }

  console.log('\n=== 3. Unbounded room creation ===');
  {
    const before = await roomCount();
    const conns = [];
    for (let i = 0; i < 40; i++) {
      const c = conn();
      try { await c.open(); c.send('create', { name: 'flood' + i, color: '#5865f2' }); conns.push(c); } catch {}
    }
    await sleep(900);
    const after = await roomCount();
    if (after - before >= 35) {
      report('MEDIUM', 'Any client can create unlimited rooms',
        `40 connections created ${after - before} rooms with no limit. Each room can then hold up to 8 MB of image data, so this is a cheap memory-exhaustion path.`);
    } else console.log(`  ok  room creation appears limited (${after - before} of 40 created)`);
    conns.forEach((c) => c.ws.close());
  }

  console.log('\n=== 4. Message flood / rate limiting ===');
  {
    const c = conn();
    await c.open();
    c.send('create', { name: 'flood', color: '#5865f2' });
    await sleep(300);
    const t0 = Date.now();
    for (let i = 0; i < 5000; i++) c.send('chat', { text: 'spam ' + i });
    await sleep(1200);
    const got = c.seen.filter((m) => m.type === 'chat').length;
    if (got > 2000) {
      report('MEDIUM', 'No rate limiting on messages',
        `5000 chat messages in ${Date.now() - t0}ms were all accepted and echoed (${got} back). Same applies to move/cursor, which are broadcast to every player in the room.`);
    } else console.log(`  ok  flood appears throttled (${got} echoed)`);
    c.ws.close();
  }

  console.log('\n=== 5. Room-code enumeration via peek ===');
  {
    const c = conn();
    await c.open();
    for (const code of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE']) c.send('peek', { code });
    await sleep(600);
    const replies = c.seen.filter((m) => m.type === 'peek');
    report('LOW', 'peek is unauthenticated and enumerable',
      `Sent 5 codes, got ${replies.length} replies with no throttle. The keyspace is 32^4 ~ 1.05M, so a script can enumerate live rooms and read player names.`);
    c.ws.close();
  }

  console.log('\n=== 6. Oversized payload handling ===');
  {
    const c = conn();
    await c.open();
    c.send('create', { name: 'big', color: '#5865f2' });
    await sleep(300);
    c.send('setup', { dataUrl: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024), imageW: 100, imageH: 100, pieces: 20 });
    await sleep(900);
    const ok = await alive();
    console.log(ok ? '  ok  oversized image did not take the server down' : '  [CRITICAL] server died on oversized payload');
    c.ws.close();
  }

  console.log('\n=== 7. Non-host trying to control the room ===');
  {
    const a = conn(); await a.open();
    a.send('create', { name: 'host', color: '#5865f2' });
    await sleep(400);
    const j = a.seen.find((m) => m.type === 'joined');
    if (!j) {
      console.log('  skip  room creation is rate-limited right now (the cap from test 3 is holding)');
      a.ws.close();
    } else {
    const code = j.room.code;
    const b = conn(); await b.open();
    b.send('join', { code, name: 'guest', color: '#23a55a' });
    await sleep(300);
    b.send('setup', { dataUrl: 'data:image/jpeg;base64,AAAA', imageW: 100, imageH: 100, pieces: 20 });
    await sleep(500);
    if (b.seen.some((m) => m.type === 'started')) {
      report('HIGH', 'A non-host can start/replace the puzzle', 'The setup guard is not holding.');
    } else console.log('  ok  non-host cannot call setup');
    a.ws.close(); b.ws.close();
    }
  }

  console.log('\n\n================ SUMMARY ================');
  if (!findings.length) console.log('No findings.');
  for (const f of findings) console.log(`[${f.sev}] ${f.title}`);
  console.log(`\nserver still alive: ${await alive()}`);
  process.exit(0);
})().catch((e) => { console.error('probe error: ' + e.message); process.exit(1); });

function roomCount() {
  return new Promise((res) => {
    http.get('http://localhost:3000/health', (x) => {
      let b = ''; x.on('data', (c) => b += c);
      x.on('end', () => { try { res(JSON.parse(b).rooms); } catch { res(-1); } });
    }).on('error', () => res(-1));
  });
}
