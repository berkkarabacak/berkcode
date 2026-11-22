import { EventEmitter } from 'node:events';

/** App-wide event bus. Events are forwarded to browsers over Server-Sent Events. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, data) {
  bus.emit('event', { type, data });
}
