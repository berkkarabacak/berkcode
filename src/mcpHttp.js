// Serves the project memory tools over MCP (Streamable HTTP) for agents that run as separate programs (Kimi).
// Each run gets a random one-time address that only works for that run's project and only while the run lasts.
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  MEMORY_SERVER, MEMORY_DESCRIPTION, SEARCH_DESCRIPTION, memoryInputShape, searchInputShape, memoryHandlers,
} from './memoryTools.js';
import { SERVER_MODE, isLoopback } from './serverMode.js';

const grants = new Map();
let serverPort = null;

export function setServerPort(port) {
  serverPort = port;
}

export function getServerPort() {
  return serverPort;
}

/** Opens a memory address for one run. Returns the URL and a function that closes it again. */
export function grantMemoryAccess({ projectId, changedBy, onWrite, port = serverPort }) {
  if (!port) throw new Error('The memory service is not ready yet.');
  const token = crypto.randomBytes(24).toString('hex');
  grants.set(token, { projectId, changedBy, onWrite });
  return {
    url: `http://127.0.0.1:${port}/mcp/${token}`,
    revoke: () => grants.delete(token),
  };
}

function buildServer(grant) {
  const server = new McpServer({ name: MEMORY_SERVER, version: '1.0.0' });
  const handlers = memoryHandlers(grant.projectId, grant);
  server.registerTool(
    'memory',
    { description: MEMORY_DESCRIPTION, inputSchema: memoryInputShape, annotations: { openWorldHint: false, destructiveHint: false } },
    handlers.memory
  );
  server.registerTool(
    'memory_search',
    { description: SEARCH_DESCRIPTION, inputSchema: searchInputShape, annotations: { readOnlyHint: true, openWorldHint: false } },
    handlers.search
  );
  return server;
}

/** Adds POST /mcp/:token to the app. Stateless: every request gets a fresh server bound to the run's project. */
export function mountMemoryMcp(app) {
  // Only agents on this same machine use these addresses; on a server they never answer the outside world.
  app.use('/mcp', (req, res, next) => (SERVER_MODE && !isLoopback(req.socket.remoteAddress) ? res.status(404).end() : next()));
  app.post('/mcp/:token', async (req, res) => {
    const grant = grants.get(req.params.token);
    if (!grant) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'This memory address is not valid (the run has ended).' }, id: null });
      return;
    }
    const server = buildServer(grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Memory service error:', err.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp/:token', notAllowed);
  app.delete('/mcp/:token', notAllowed);
}
