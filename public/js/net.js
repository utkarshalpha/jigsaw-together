/* Thin websocket wrapper: same-origin connect, typed events, auto-reconnect.
 * Reconnects re-run whatever `resume` callback the app installed, so a dropped
 * laptop lid rejoins the same room instead of dumping you back at the lobby. */

const Net = (() => {
  const handlers = new Map();
  let ws = null;
  let retries = 0;
  let resume = null;      // () => void, replayed after a reconnect
  let intentionalClose = false;

  const url = () =>
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

  function emit(type, data) {
    const list = handlers.get(type);
    if (list) for (const fn of list) fn(data);
  }

  function connect() {
    intentionalClose = false;
    ws = new WebSocket(url());

    ws.onopen = () => {
      retries = 0;
      emit('open');
      if (resume) resume();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      emit(msg.type, msg);
    };

    ws.onclose = () => {
      emit('close');
      if (intentionalClose) return;
      // Back off, but keep trying - a room is worth reconnecting to.
      const wait = Math.min(8000, 500 * Math.pow(1.7, retries++));
      setTimeout(connect, wait);
    };

    ws.onerror = () => { /* onclose always follows; handled there */ };
  }

  return {
    connect,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    send(type, data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...data }));
        return true;
      }
      return false;
    },
    setResume(fn) { resume = fn; },
    get ready() { return ws && ws.readyState === WebSocket.OPEN; }
  };
})();
