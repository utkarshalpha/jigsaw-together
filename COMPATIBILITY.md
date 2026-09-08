# Device compatibility

An audit of what this app relies on and how each platform behaves, plus the
fixes that came out of it. Every item below is a real platform behaviour, not a
precaution — where something is unverified, it says so.

## Support floor

| Platform | Works from | Notes |
| --- | --- | --- |
| Chrome / Edge (Windows, macOS, Android) | 111 | `color-mix` is the newest thing used, and it has a fallback, so 90+ works with a slightly flatter badge |
| Safari (macOS, iOS, iPadOS) | 15.4 | 15.0–15.3 play fine; voice/video needs the 15.4 fallback described below |
| Firefox (desktop, Android) | 110 | full support |
| Samsung Internet | 21 | Chromium-based, follows Chrome |

Below those, the app shows a plain "this browser can't run the board" panel
naming the missing feature, instead of a blank screen.

## What each platform broke, and the fix

### iOS Safari

**`100vh` is taller than the screen.** iOS measures `100vh` against the viewport
with the URL bar retracted, so a full-height element hangs off the bottom. The
board lost its bottom strip and the mobile sheet's buttons sat under the browser
chrome. Every full-height rule now ships `vh` first and `dvh` second, so older
engines keep the old value and newer ones get the honest one.

**Focusing an input zoomed the whole page.** iOS zooms in on any text field
whose font is under 16px and never zooms back out, which leaves the canvas
mis-scaled for the rest of the session. Inputs are 16px on touch layouts.

**`user-scalable=no` is ignored.** It has been ignored since iOS 10, so pinching
zoomed the page instead of the board. The canvas cancels `gesturestart` /
`gesturechange` / `gestureend` and swallows the second of a double tap.

**Audio would not start.** Two separate problems. The app never attached remote
audio to any element at all when the sender had no camera — that was a plain bug
and is fixed with a dedicated hidden `<audio>` per peer. On top of that, iOS
refuses playback until the page has seen a real user gesture, so `play()` is
retried from the mic button and from the first tap anywhere, and the panel says
"tap to enable sound" while it is still blocked.

**Long-press raised the system callout** over a piece mid-drag.
`-webkit-touch-callout: none` on the board and the draggable chrome.

**`setLocalDescription()` with no arguments** — the call perfect negotiation is
built around — only arrived in Safari 15.4. There is now a fallback that calls
`createOffer`/`createAnswer` explicitly based on signalling state, so 15.0–15.3
still connect.

### Android Chrome

**The URL bar resizes the viewport without a `resize` event.** The board kept a
stale size after the bar hid. `visualViewport`'s resize event now triggers a
refit, debounced.

**Back button left the game.** With the mobile sheet open, Back exited the page
rather than closing the sheet. Opening an overlay pushes a history entry that
Back consumes, so the first press closes the sheet and only a second one leaves.

**Long-press callout** — same fix as iOS.

### Windows / desktop

**Middle-click started autoscroll** while middle-drag was meant to pan.
`mousedown` and `auxclick` are cancelled for button 1.

**Right-click opened the context menu** over a piece being dragged. Cancelled on
the canvas.

**Trackpad pinch arrives as `ctrl`+wheel** with much smaller deltas than a real
wheel, so pinching barely zoomed. The zoom step is scaled up when `ctrlKey` is
set, and the event is cancelled so the browser does not zoom the page instead.

### Everywhere

**`color-mix()`** (Safari 16.2+, Chrome 111+) had no fallback, so the mic/camera
badge lost its background on older phones. A plain `rgba()` now precedes it.

**`backdrop-filter`** still needs `-webkit-` on Safari.

**Very small phones** (≤380px) wrapped the top bar. The room chip and the gaps
tighten, and every control stays reachable because they live in the panel.

## Found on a real iPhone

The audit above was static. A screenshot from an actual iPhone then showed two
things reasoning had missed:

**The top bar overflowed off the right edge.** Room code, connection, peek and
theme filled the width, and **Players and Leave were pushed off-screen with
no way to reach them** — you could not open the panel or leave the room at all.
Chips do not wrap, so nothing hinted that anything was missing.

Fixed by moving, not shrinking: on a phone the whole board-control group is
relocated into the panel, where it lays out as a comfortable two-column grid
with proper touch targets. The bar keeps only what has to be glanceable — room
code, connection, the panel toggle and Leave — and the toggle becomes a burger.
The group is moved rather than duplicated, so there is only ever one of each
button, and it moves back into the bar on a wide screen.

Peek stays in the bar at every size - it is the one control used constantly
while playing - and Leave sits inside the panel with the settings, so exiting is
deliberately one step further away than peeking. Inside a bottom sheet the exit
confirmation opens upward, since there is no room below it.

**The board sat in a sea of empty space.** Fitting the whole board means fitting
its width on a portrait phone, and since the board is slightly wider than it is
tall, most of the screen went unused and every piece was tiny. On a tall screen
the view now fills the height and lets you pan sideways to the trays, which is
roughly twice the piece area. Fit still snaps back to the whole board.

**A later screenshot showed the top bar had vanished entirely.** That one was
self-inflicted: the compatibility pass added `viewport-fit=cover`, which lets the
page use the area behind the iOS status bar, and the hand-written safe-area
padding meant to compensate resolved to zero in ordinary Safari - so the bar sat
underneath the clock and signal icons. Reverted: without `viewport-fit=cover`
Safari lays the page out below its own chrome, which is exactly what the first
screenshot showed working. Worth remembering that `cover` is for full-screen web
apps, not for a page that still has browser chrome around it.

## Known limits

- **Voice/video uses public STUN and no TURN.** A small number of strict
  corporate and carrier-grade NATs will fail to establish a peer connection.
  Everything else — board, cursors, chat — is unaffected. Adding a TURN server
  is the fix if that ever matters.
- **A mesh call** costs each participant (n−1) uploads. Fine for the room sizes
  here; past a handful of cameras it wants an SFU.
- **`aspect-ratio`** (Safari 15+) has no fallback. On Safari 14 the gallery tiles
  and PiP windows lose their shape, though the game still plays.
- **iOS low power mode** throttles timers and may pause video tracks. Nothing to
  do about it from script.

## Still not verified on real hardware

The items in the first section are static: each was checked against documented platform
behaviour and the code was changed accordingly, but it has **not** been run on a
physical iPhone, iPad or Android device. The things most worth confirming by
hand are the audio unlock on iOS Safari, the bottom sheet's drag-to-dismiss, and
that the board fills the screen with the URL bar both shown and hidden.
