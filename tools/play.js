#!/usr/bin/env node
/* One command to get a public game running: `npm run play`.
 *
 * Starts the server if it isn't already up, opens a Cloudflare quick tunnel,
 * waits until the public URL genuinely serves, and prints it.
 *
 * Quick tunnels mint a new random hostname every run, so the link is different
 * each time - that is a property of free tunnels, not a bug. Keep this window
 * open for as long as you want people to be able to join. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');

const CF_CANDIDATES = [
  'cloudflared',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b.includes('"ok":true')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findCloudflared() {
  for (const c of CF_CANDIDATES) {
    if (c.includes(path.sep) && fs.existsSync(c)) return c;
  }
  return 'cloudflared';                  // hope it is on PATH
}

/* The URL appears in cloudflared's banner long before the edge will actually
 * serve it, so poll the real thing rather than trusting the log. */
function serves(url) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(url + '/health', { timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(res.statusCode === 200 && b.includes('"ok":true')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  let server = null;

  if (await health()) {
    log(`server     already running on :${PORT}`);
  } else {
    log(`server     starting on :${PORT}...`);
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
    server.stderr.on('data', (d) => process.stderr.write('  [server] ' + d));
    for (let i = 0; i < 40 && !(await health()); i++) await sleep(250);
    if (!(await health())) { console.error('server failed to start'); process.exit(1); }
    log(`server     up`);
  }

  const bin = findCloudflared();
  log(`tunnel     starting (${bin === 'cloudflared' ? 'from PATH' : bin})...`);
  const cf = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  cf.on('error', (e) => {
    console.error(`\ncould not run cloudflared: ${e.message}`);
    console.error('install it with:  winget install Cloudflare.cloudflared');
    process.exit(1);
  });

  let url = null;
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !url) url = m[0];
  };
  cf.stdout.on('data', scan);
  cf.stderr.on('data', scan);

  for (let i = 0; i < 80 && !url; i++) await sleep(250);
  if (!url) { console.error('tunnel did not report a URL'); process.exit(1); }

  log(`tunnel     ${url}`);
  log(`           waiting for the edge to start serving...`);

  let live = false;
  for (let i = 0; i < 40 && !live; i++) { live = await serves(url); if (!live) await sleep(1500); }

  const line = '='.repeat(Math.max(34, url.length + 4));
  console.log('\n' + line);
  console.log('  ' + url);
  console.log(line);

  if (live) {
    console.log('  Ready. Open it on any device, anywhere.');
  } else {
    console.log('  The tunnel is up but not answering here yet.');
    console.log('  That is usually your local DNS lagging behind - try it on');
    console.log('  mobile data, or give it a minute on WiFi.');
  }
  console.log('  This link dies when you close this window.\n');

  const bye = () => {
    try { cf.kill(); } catch { /* already gone */ }
    if (server) { try { server.kill(); } catch { /* already gone */ } }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  cf.on('exit', (code) => { console.log(`\ntunnel stopped (code ${code}).`); bye(); });
})();
