// Server mode: the app runs on a server for several people, behind HTTPS, instead of on one person's own computer.
// Turned on with RUNNER_SERVER=1 (see deploy/README.md). Everyone signs in with one shared password (src/auth.js),
// and the features that only make sense on the owner's Windows computer are switched off.
export const SERVER_MODE = process.env.RUNNER_SERVER === '1';

/** The address people open, for example https://agents.berkkarabacak.com. Requests for other host names are refused. */
export const PUBLIC_URL = String(process.env.RUNNER_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');

function parsed() {
  try {
    return PUBLIC_URL ? new URL(PUBLIC_URL) : null;
  } catch {
    return null;
  }
}
export const PUBLIC_HOST = parsed()?.hostname.toLowerCase() ?? null;
export const PUBLIC_ORIGIN = parsed()?.origin ?? null;

/** Where the web server listens: 127.0.0.1 on a computer; 0.0.0.0 in a container (published to the host's loopback only). */
export const LISTEN_HOST = process.env.RUNNER_HOST || '127.0.0.1';

/** True for a connection from this same machine (or container). */
export const isLoopback = (address) => /^(127\.|::1$|::ffff:127\.)/.test(String(address ?? ''));
