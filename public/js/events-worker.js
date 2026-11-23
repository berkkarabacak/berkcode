// One connection for live updates, shared by every open page of the app (a SharedWorker). Browsers allow only about
// six connections to the app at a time: if every page kept its own, a handful of forgotten tabs would use them all
// up and every page of the app would freeze.
const ports = new Set();
let source = null;
let connection = 'connecting'; // 'connecting' | 'open' | 'down'

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function connect() {
  connection = 'connecting';
  source = new EventSource('/api/events');
  source.onopen = () => {
    connection = 'open';
    broadcast({ kind: 'open' });
  };
  source.onerror = () => {
    connection = 'down';
    broadcast({ kind: 'error' });
    // The browser reconnects by itself, unless it gave up on this connection.
    if (source.readyState === EventSource.CLOSED) {
      source = null;
      setTimeout(connect, 3000);
    }
  };
  source.onmessage = (m) => broadcast({ kind: 'event', data: m.data });
}

self.onconnect = (e) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = (m) => {
    if (m.data === 'bye') ports.delete(port);
  };
  port.start();
  if (!source && connection !== 'down') connect();
  // A new page learns the current state, so it can show "not running" or reload its data when the app is back.
  if (connection === 'open') port.postMessage({ kind: 'open' });
  else if (connection === 'down') port.postMessage({ kind: 'error' });
};
