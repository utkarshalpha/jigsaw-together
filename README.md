# Jigsaw Together

### ▶ Play it: **https://playjigsaw.onrender.com**

Open it on two devices, start a room, share the code. Nothing to install.

> Running on a free instance, so if nobody has used it for a while the first
> load can take up to a minute to wake up. After that it is instant.

---

A collaborative jigsaw puzzle on one shared board — the Figma/Canva model, not
turn-taking. Everyone drags pieces on the **same** board at the same time, and
you see each other's cursors move live, labelled with their name and colour.

Two players or twelve. Nobody needs to be on the same network.

## What it does

- **One shared board.** Every piece position is shared state. When someone moves
  a piece, it moves on your screen too.
- **Live cursors.** Each player's pointer is drawn with their name and colour, in
  board coordinates — so it lands in the right place even though everyone has a
  different window size, pan and zoom.
- **Real jigsaw pieces.** Interlocking knobs and sockets generated per edge, not
  squares. Neighbouring edges are cut from one shared descriptor, so a knob on one
  piece is exactly the socket on the next.
- **Piece locking.** Two people can't drag the same piece; it's held by whoever
  grabbed it first and outlined in their colour for everyone else.
- **Groups.** Pieces that snap together become one assembly and move as a unit.
- **Talk while you play.** Mic and camera, peer-to-peer. Audio and video go
  browser-to-browser; the server only passes the handshake and never carries a
  single frame. Off by default, and your browser still asks permission on top.
- **15 famous paintings** built in — Starry Night, The Great Wave, The Kiss,
  La Grande Jatte, Hunters in the Snow, Bosch's Garden of Earthly Delights and
  more. All long out of copyright. Or upload your own photo.
- **~126 pieces**, fixed. No dial to fiddle with before you can start playing.
- **Scoreboard.** Live count of who has locked in how many pieces, with a crown
  for whoever's ahead, and medals on the finish screen.
- **Hold to peek.** Press and hold to see the finished picture; let go and it's
  gone, so nobody leaves the answer parked on screen.
- **Confetti** when the last piece goes in.
- Chat (foldable), progress bar, timer, a Leave button, and a shuffle for the host.
- **See the room before you enter it.** Type a code on the join screen and it's
  checked live: who is already playing, what they are playing, and which colours
  are gone. Taken colours grey out, and the room reassigns duplicates anyway.
- **Tidy tray, not a heap.** Pieces start in a non-overlapping ring around the
  board, so every one is visible and grabbable from the first second.
- **Works on a phone.** The side panel becomes a bottom sheet you can swipe
  down to dismiss, pinch to zoom, drag to pan. See COMPATIBILITY.md for the
  per-platform audit.
- **Refresh-safe.** Reloading drops you straight back into your room.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. Click **Start a new puzzle**, pick a painting, and
share the room code — or the invite link, which the **Room** button in the top
bar copies for you.

That URL only works on your own machine. To actually play with other people,
pick one of the two options below.

## Playing with people who aren't on your network

### Option A - a tunnel from this PC (instant, temporary)

```bash
npm run play
```

That starts the server if it isn't already running, opens a Cloudflare quick
tunnel, waits until the public address genuinely answers, and prints it:

```
=========================================================
  https://something-random.trycloudflare.com
=========================================================
  Ready. Open it on any device, anywhere.
```

Send that link to anyone. No account needed on either end, and it costs
nothing.

Two things to expect:

- **The address is different every run.** Quick tunnels mint a random hostname
  each time; that is how the free tier works, not a fault. The link lives
  until you close the window.
- **If it will not load, suspect DNS before the tunnel.** A home router's
  resolver often has not heard of a brand-new hostname yet and returns
  NXDOMAIN while the tunnel is serving perfectly. Mobile data usually works
  immediately; WiFi catches up within a minute or two. `npm run play` polls
  the real URL and tells you which case you are in.

`npm run share` runs only the tunnel, for when the server is already going.

### Option B - host it permanently (already done)

This is deployed at **https://playjigsaw.onrender.com** on Render's free
tier, managed by the `render.yaml` in this repo. Pushing to `main` redeploys
it automatically - the blueprint is the source of truth, so nothing is
configured by hand in the dashboard.

To stand up your own copy:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/utkarshalpha/jigsaw-together)

Or: [render.com](https://render.com) → **New → Blueprint** → pick the repo →
**Apply**. Render reads the runtime, build, start command, health check and
env vars from `render.yaml`.

Anything that runs a Node process works the same way - Railway, Fly.io,
Koyeb, a VPS. `PORT` comes from the environment and `/health` is there for
health checks. Set `TRUST_PROXY=1` behind any reverse proxy, or the per-IP
rate limits will treat every player as the same client.

What the free tier costs you, and what to do about it:

- **It sleeps after ~15 minutes idle**, and the first request afterwards
  takes up to a minute to wake it. Fine for a game you arrange in advance,
  irritating if someone opens the link cold.
- **Rooms live in memory**, so a sleep or redeploy ends any game in
  progress. Everyone starts a new one; nothing is corrupted.

**Keeping it awake, still free.** Render gives 750 instance-hours a month and
a month is about 730 hours, so one service can stay up continuously inside
the free allowance - the hours are the budget, not the uptime. Point any free
uptime pinger (cron-job.org, UptimeRobot) at:

```
https://playjigsaw.onrender.com/health
```

every 10 minutes. `/health` is a trivial JSON response, so this costs almost
nothing and removes both the cold start and most of the state loss. The
budget only covers **one** always-on free service.

## Controls

| Action | How |
| --- | --- |
| Move a piece | Drag it (or one finger on touch) |
| Pan the board | Drag empty felt, or hold Shift, or middle-drag |
| Zoom | Mouse wheel, or pinch on a touchscreen |
| Fit board to screen | `F`, or the **Fit** button |
| Peek at the picture | **Hold** `P`, or hold the **Hold to peek** button in the top bar |
| Talk / show your face | **Mic** and **Camera** in the side panel |
| Leave the room | **Leave** (asks once before it acts) |

Pieces snap when dropped close enough to a correct neighbour, and locked
assemblies then drag as one.

## How it fits together

```
server.js          rooms, authoritative piece state, websocket relay
shared/puzzle.js   grid sizing, edge generation, snap/merge rules
                   (loaded by BOTH server and browser, so they never disagree)
public/js/
  gallery.js       the 15 built-in paintings (URLs, not bundled bytes)
  pieces.js        jigsaw outlines + one pre-rendered canvas per piece
  net.js           websocket wrapper with auto-reconnect
  rtc.js           peer-to-peer mic/camera, signalled over that websocket
  app.js           board rendering, input, cursors, all the UI
```

Some choices worth knowing about:

- **Plain websockets, not Socket.IO.** The `ws` library server-side and the
  browser's built-in `WebSocket` client-side. Socket.IO's value is its
  long-polling fallback and reconnect logic; we don't need the first, and the
  reconnect we do need is about 20 lines in `net.js`. Skipping it keeps the page
  at zero client-side dependencies — nothing to download before you can play.
- **Voice/video is a mesh, not a server.** Each pair of players holds one
  `RTCPeerConnection`, so media never touches the host. That's what makes a call
  viable over a free tunnel or a free-tier dyno. A mesh costs each player
  (n−1) uploads, which is fine at these room sizes but would want an SFU past a
  handful of cameras.

- **Board units.** All shared positions are in a virtual board space, never
  pixels. Each client applies its own pan/zoom on top. That's what lets a phone
  and a monitor share a board, and cursors still land correctly.
- **Groups carry one translation.** Pieces inside an assembly are always in their
  correct relative arrangement, so a group needs a single offset rather than a
  position per piece. Merging two assemblies is then just comparing offsets,
  which is also what makes snapping cheap.
- **The server referees snapping.** Clients move pieces optimistically for
  responsiveness, but merges are decided server-side using the shared module, so
  no one's board can drift out of agreement.
- **Pieces are pre-rendered once,** shadow and all. Each piece becomes a small
  canvas at load time and the frame loop only blits it. Baking the drop shadow in
  costs one fill per piece at load instead of a blur per piece per frame.
- **The tray is a ring, not two side columns.** Columns down the left and right
  make the board three or four times wider than tall, and fitting that to a
  screen shrinks every piece. A ring keeps the board near the picture's own
  proportions, which is what keeps pieces big.

## Tests

`npm start` first, then:

```bash
npm test               # protocol + snapping, 29 checks
npm run test:security  # hostile-input probe
```

**`tests/protocol.test.js`** drives real websocket clients through room
creation, joining, a rejected room code, lobby peeking (unknown room, listing
who is present, and that peeking does not join you), duplicate-colour
reassignment, piece locking, drag relay, move authorisation, snap-merge, a full
24-piece solve, WebRTC signalling relay including that a signal aimed at an
unknown peer is dropped rather than broadcast, mic/camera state announcement,
what a late joiner is told about an in-progress call, chat, and host handover on
disconnect.

**`tests/snap.test.js`** covers the join mechanic the way a person actually
plays it: dropping *near* a neighbour rather than exactly on it, refusing a drop
that is too far away, and checking that a joined assembly moves as one unit,
keeps its pieces in exact relative positions, and does not jump when a single
piece joins it.

**`tests/security.probe.js`** throws hostile input at a running server — type
confusion, a foreign `Origin`, room flooding, message flooding, code
enumeration, oversized payloads, and a non-host trying to control the room — and
reports what survives.

Point any of them at a deployed instance:

```bash
JT_URL=wss://playjigsaw.onrender.com npm test
```

All three suites pass against the live deployment.

**`tools/score-art.js`** measures how solvable a painting is as a jigsaw. Run it
before adding anything to the gallery.

## Why not Vercel

Vercel Functions do support WebSockets now, and this stack (Express + `ws`)
would run there. It is still the wrong host for this app, for one reason from
Vercel's own docs: *"New WebSocket connections are not guaranteed to reach the
same Vercel Function instance."*

The whole board - rooms, piece positions, who is holding what - is one in-memory
Map. Two players on different instances would not see the same game, and each
connection is also cut at the function's max duration. Making it work means
moving all shared state into Redis with pub/sub between instances, and making
snap-merge atomic so two instances cannot resolve a drop at once.

That is a real option, not a hard no - it is just a different piece of work.
A single persistent process is what a shared in-memory board wants, so any
always-on host (Render, Fly, Railway, a VPS) fits it without changes.

## Device support

Chrome/Edge 111+, Safari 15.4+, Firefox 110+, on desktop, Android and iOS.
Older browsers get a panel naming the missing feature rather than a blank board.
**COMPATIBILITY.md** has the full per-platform audit: what each one broke and how
it was fixed.

## Limits

- Rooms live in memory. Restart the server and they're gone; empty rooms are
  dropped after 30 minutes. Fine for playing with friends, not a persistence layer.
- 12 players per room, 8 MB per uploaded picture (uploads are downscaled to
  1600px in the browser before sending).
- The built-in paintings are fetched by each player's browser from Wikimedia
  Commons, so players need to be able to reach it. Uploads have no such
  dependency - they travel through the room itself.
- Mic and camera need https. The tunnel and any real host give you that; a bare
  http://192.168.x.x will not, and the buttons disable themselves and say so.
- Voice/video uses public STUN and no TURN, so a small number of strict
  corporate or carrier-grade NATs will fail to connect. Chat still works.
