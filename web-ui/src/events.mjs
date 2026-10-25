// Server-sent events hub with a short replay buffer for reconnecting clients.
const HISTORY_SIZE = 500;
const HEARTBEAT_MS = 20_000;

export class EventHub {
  #clients = new Set();
  #history = [];
  #sequence = 1;

  /** `replay: false` skips the reconnect buffer (high-volume streams such as terminal output). */
  emit(type, data = {}, { replay = true } = {}) {
    const event = { id: this.#sequence++, type, data, at: new Date().toISOString() };
    if (replay) {
      this.#history.push(event);
      if (this.#history.length > HISTORY_SIZE) this.#history.shift();
    }
    const frame = toFrame(event);
    for (const res of this.#clients) res.write(frame);
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(': connected\n\n');
    const lastId = Number(req.headers['last-event-id'] || 0);
    for (const event of this.#history) if (event.id > lastId) res.write(toFrame(event));
    this.#clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => { clearInterval(heartbeat); this.#clients.delete(res); });
  }
}

function toFrame(event) {
  return `id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}
