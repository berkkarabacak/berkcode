import readline from 'node:readline';

/**
 * Minimal JSON-RPC 2.0 connection over a child process's stdin/stdout, one JSON message per line
 * (the transport used by the Agent Client Protocol).
 */
export class JsonRpcConnection {
  constructor(child, { onRequest = async () => null, onNotification = () => {} } = {}) {
    this.child = child;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    child.on('exit', (code, signal) => this.#fail(new Error(`Kimi Code CLI stopped (exit code ${code ?? signal}).`)));
    child.on('error', (err) => this.#fail(err));
  }

  #send(message) {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    } catch {
      /* the process is gone; #fail handles pending calls */
    }
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method) {
      if (msg.id !== undefined && msg.id !== null) {
        Promise.resolve()
          .then(() => this.onRequest(msg.method, msg.params))
          .then(
            (result) => this.#send({ id: msg.id, result: result ?? null }),
            (err) => this.#send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } })
          );
      } else {
        try {
          this.onNotification(msg.method, msg.params);
        } catch (err) {
          console.error('Error while handling a Kimi update:', err.message);
        }
      }
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || 'Unknown error'), { code: msg.error.code, data: msg.error.data }));
    else waiter.resolve(msg.result);
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  request(method, params, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new Error('Kimi Code CLI is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(Object.assign(new Error(`Kimi Code CLI did not answer "${method}" in time.`), { code: 'timeout' }));
        }, timeoutMs);
      }
      this.#send({ id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ method, params });
  }
}
