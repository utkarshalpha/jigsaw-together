/* Voice and video between everyone in the room.
 *
 * A full mesh: each pair of players holds one RTCPeerConnection and media flows
 * straight between their browsers. The game server only forwards descriptions
 * and ICE candidates - it never carries audio or video.
 *
 * Two patterns from the WebRTC spec do the heavy lifting here, and both matter:
 *
 *  1. PERFECT NEGOTIATION (w3c/webrtc-pc #1810, documented on MDN). Each pair
 *     agrees on a "polite" and an "impolite" side by comparing ids. If both
 *     sides offer at once, the polite one rolls back and the impolite one holds
 *     firm, so a collision resolves instead of deadlocking. Naive schemes like
 *     "the higher id always offers" work for the first connection and then fall
 *     apart the moment someone toggles a camera mid-call.
 *
 *  2. FIXED TRANSCEIVERS + replaceTrack. Every connection is built with one
 *     audio and one video transceiver up front. Muting or unmuting then swaps
 *     the track on the existing sender rather than adding and removing tracks,
 *     so toggling a mic costs no renegotiation at all.
 *
 * Nothing starts until the player turns on a mic or camera, and the browser
 * still asks its own permission on top of that. */

const RTC = (() => {
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];

  /** id -> { pc, polite, makingOffer, ignoreOffer, isSettingRemoteAnswerPending,
   *          audioTx, videoTx, stream } */
  const peers = new Map();

  // Held separately so toggling the mic never re-prompts for the camera.
  let micTrack = null;
  let camTrack = null;
  let myId = null;
  let h = {};

  const isSecure = () =>
    window.isSecureContext ||
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1'].includes(location.hostname);

  const note = (m) => h.onNote && h.onNote(m);

  /* setLocalDescription() with no arguments picks the right description type
   * on its own, and perfect negotiation is written around it. Safari only
   * shipped it in 15.4, and older Android WebViews lack it too, so fall back to
   * doing it the long way when it is missing. */
  async function setLocal(pc) {
    try {
      await pc.setLocalDescription();
    } catch (e) {
      if (e && (e.name === 'TypeError' || e.name === 'NotSupportedError')) {
        const desc = pc.signalingState === 'have-remote-offer'
          ? await pc.createAnswer()
          : await pc.createOffer();
        await pc.setLocalDescription(desc);
      } else {
        throw e;
      }
    }
  }

  function ensurePeer(id) {
    let p = peers.get(id);
    if (p) return p;

    const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
    p = {
      pc,
      // Deterministic and opposite on both sides, so exactly one is polite.
      polite: String(myId) < String(id),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      stream: null
    };
    // Created once, reused forever - this is what makes muting free.
    p.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    if (micTrack) p.audioTx.sender.replaceTrack(micTrack).catch(() => {});
    if (camTrack) p.videoTx.sender.replaceTrack(camTrack).catch(() => {});

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await setLocal(pc);
        Net.send('rtc', { to: id, kind: 'desc', payload: pc.localDescription.toJSON() });
      } catch (e) {
        note('Call setup failed: ' + e.message);
      } finally {
        p.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) Net.send('rtc', { to: id, kind: 'ice', payload: candidate.toJSON() });
    };

    pc.ontrack = ({ track, streams }) => {
      p.stream = streams[0] || new MediaStream([track]);
      // A track that is muted carries no media yet; re-report when it wakes up
      // so a tile doesn't sit there black.
      track.onunmute = () => h.onStream && h.onStream(id, p.stream);
      track.onmute = () => h.onStream && h.onStream(id, p.stream);
      h.onStream && h.onStream(id, p.stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Usually a network path change; ask ICE to find a new one before giving up.
        try { pc.restartIce(); } catch { drop(id); }
      } else if (pc.connectionState === 'closed') {
        drop(id);
      }
      h.onPeerState && h.onPeerState(id, pc.connectionState);
    };

    peers.set(id, p);
    return p;
  }

  /* The whole of perfect negotiation lives here. */
  async function handle(msg) {
    const { from, kind, payload } = msg;
    if (!from || !payload) return;
    const p = ensurePeer(from);
    const pc = p.pc;

    try {
      if (kind === 'desc') {
        const description = payload;
        const readyForOffer =
          !p.makingOffer &&
          (pc.signalingState === 'stable' || p.isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        p.ignoreOffer = !p.polite && offerCollision;
        if (p.ignoreOffer) return;                    // impolite side stands its ground

        p.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);   // polite side rolls back here
        p.isSettingRemoteAnswerPending = false;

        if (description.type === 'offer') {
          await setLocal(pc);
          Net.send('rtc', { to: from, kind: 'desc', payload: pc.localDescription.toJSON() });
        }
      } else if (kind === 'ice') {
        try {
          await pc.addIceCandidate(payload);
        } catch (e) {
          // Candidates for an offer we deliberately ignored are expected to fail.
          if (!p.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      note('Call error: ' + e.message);
    }
  }

  function drop(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch { /* already gone */ }
    peers.delete(id);
    h.onGone && h.onGone(id);
  }

  // Push whatever we currently have onto every open connection.
  async function pushTracks() {
    for (const p of peers.values()) {
      try {
        await p.audioTx.sender.replaceTrack(micTrack);
        await p.videoTx.sender.replaceTrack(camTrack);
      } catch (e) {
        note('Could not update the call: ' + e.message);
      }
    }
  }

  const announce = () =>
    Net.send('rtcState', { audio: !!micTrack, video: !!camTrack });

  async function getMedia(kind) {
    if (!isSecure()) {
      throw new Error('Mic and camera need https. Open the shared https link, not a plain IP.');
    }
    const constraints = kind === 'audio'
      ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
      : { video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot share a mic or camera. Try Chrome, Safari or Edge.');
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
  }

  function selfStream() {
    const tracks = [micTrack, camTrack].filter(Boolean);
    return tracks.length ? new MediaStream(tracks) : null;
  }

  return {
    init(id, handlers) { myId = id; h = handlers || {}; },
    setId(id) { myId = id; },

    /* Open connections to everyone we should be talking to. Called when we turn
     * media on, and when somebody else announces theirs. */
    connect(ids) {
      for (const id of ids) if (id !== myId) ensurePeer(id);
    },

    handle,
    drop,

    async setAudio(on) {
      if (on && !micTrack) {
        micTrack = await getMedia('audio');
        micTrack.onended = () => { micTrack = null; pushTracks(); announce(); };
      } else if (!on && micTrack) {
        micTrack.stop();
        micTrack = null;
      }
      await pushTracks();
      announce();
      return selfStream();
    },

    async setVideo(on) {
      if (on && !camTrack) {
        camTrack = await getMedia('video');
        camTrack.onended = () => { camTrack = null; pushTracks(); announce(); };
      } else if (!on && camTrack) {
        camTrack.stop();
        camTrack = null;
      }
      await pushTracks();
      announce();
      return selfStream();
    },

    get audioOn() { return !!micTrack; },
    get videoOn() { return !!camTrack; },
    get anyOn() { return !!micTrack || !!camTrack; },
    get selfStream() { return selfStream(); },
    get secure() { return isSecure(); },
    get peerCount() { return peers.size; },

    // A tile can be created after the media already arrived (the rtcState
    // announcement and the track do not land in a guaranteed order), so the
    // UI needs to be able to fetch what we already hold.
    streamOf(id) { const p = peers.get(id); return p ? p.stream : null; },

    leaveAll() {
      for (const id of [...peers.keys()]) drop(id);
      if (micTrack) micTrack.stop();
      if (camTrack) camTrack.stop();
      micTrack = camTrack = null;
    }
  };
})();
