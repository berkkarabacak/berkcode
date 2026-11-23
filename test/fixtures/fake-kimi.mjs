// A stand-in for "kimi acp" used by the tests: speaks the Agent Client Protocol over stdin/stdout,
// reads and writes the project memory through the MCP address it is given, and edits files in its folder.
// Behaviour switches come from markers in the prompt: [fake:no-progress], [fake:slow], [fake:loop].
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'acp') process.exit(2);
const stateFile = path.join(process.env.FAKE_KIMI_STATE, 'sessions.json');
const loadState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sessions: {}, loads: 0, counter: 0 });
const saveState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cancelled = new Set();

const configOptions = (session) => [
  { id: 'model', currentValue: session.model, options: [{ value: 'kimi-code/k3.1-pro', name: 'K3.1 Pro' }, { value: 'kimi-code/k3', name: 'K3' }] },
  { id: 'thinking', currentValue: session.thinking, options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
  { id: 'mode', currentValue: session.mode, options: [{ value: 'default' }, { value: 'auto' }] },
];

async function mcp(url, method, params, id) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
  });
  if (!id) return null;
  return res.json();
}

async function memoryCall(session, input) {
  await mcp(session.mcpUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-kimi', version: '1' } }, 1);
  await mcp(session.mcpUrl, 'notifications/initialized', {});
  const r = await mcp(session.mcpUrl, 'tools/call', { name: 'memory', arguments: input }, 2);
  return r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
}

let toolId = 0;
async function tool(sessionId, title, kind, rawInput, run) {
  const toolCallId = `call_${++toolId}`;
  // Like the real Kimi: the call is announced with an empty input, which is filled in by a later update.
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput: {} });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', rawInput });
  const text = await run();
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] });
}

async function writeProgress(session, sessionId, cwd, title) {
  const view = await memoryCall(session, { command: 'view', path: '/memories/progress.md' });
  const lines = (view.match(/^\s*\d+\t/gm) ?? []).length;
  await tool(sessionId, 'mcp__agent_memory__memory', 'other', { command: 'insert', path: '/memories/progress.md' }, () =>
    memoryCall(session, {
      command: 'insert',
      path: '/memories/progress.md',
      insert_line: lines,
      insert_text: `\n## 2026-01-01 10:00 — ${title}\n- Done: wrote hello.txt in ${path.basename(cwd)}\n- Next step: polish\n`,
    })
  );
}

async function prompt(params) {
  const state = loadState();
  const session = state.sessions[params.sessionId];
  const text = params.prompt.map((p) => p.text ?? '').join('\n');
  const sid = params.sessionId;
  cancelled.delete(sid);
  if (/without appending a new entry/.test(text)) {
    await writeProgress(session, sid, session.cwd, 'Progress written after reminder');
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Progress entry written.' } });
    return { stopReason: 'end_turn' };
  }
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking memory first. ' } });
  await tool(sid, 'mcp__agent_memory__memory', 'other', { command: 'view', path: '/memories' }, () => memoryCall(session, { command: 'view', path: '/memories' }));
  if (/\[fake:slow\]/.test(text)) {
    for (let i = 0; i < 300 && !cancelled.has(sid); i++) await sleep(100);
    return { stopReason: cancelled.has(sid) ? 'cancelled' : 'end_turn' };
  }
  if (/\[fake:loop\]/.test(text)) {
    for (let i = 0; i < 100 && !cancelled.has(sid); i++) {
      await tool(sid, 'Read index.html', 'read', { path: 'index.html' }, async () => 'ok');
      await sleep(20);
    }
    return { stopReason: cancelled.has(sid) ? 'cancelled' : 'end_turn' };
  }
  await tool(sid, 'Write hello.txt', 'edit', { path: 'hello.txt' }, async () => {
    fs.writeFileSync(path.join(session.cwd, 'hello.txt'), `hello from session ${sid}\n`);
    return 'File written.';
  });
  if (/\[fake:continues\]/.test(text)) {
    // Like Kimi after a background task finishes: answer now, then keep working in a new turn by itself.
    setTimeout(async () => {
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The background task finished, continuing.' } });
      await sleep(400);
      await writeProgress(session, sid, session.cwd, 'Finished in a second turn');
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished the work in a second turn.' } });
    }, 300);
    return { stopReason: 'end_turn' };
  }
  if (!/\[fake:no-progress\]/.test(text)) await writeProgress(session, sid, session.cwd, 'Fake session work');
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: wrote hello.txt and recorded progress.' } });
  return { stopReason: 'end_turn' };
}

async function handle(msg) {
  const { method, params } = msg;
  const state = loadState();
  switch (method) {
    case 'initialize':
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: 'login' }], agentInfo: { name: 'Fake Kimi', version: '0.0.1' } };
    case 'session/new': {
      if (process.env.FAKE_KIMI_AUTH === '1') throw Object.assign(new Error('Authentication required'), { code: -32000 });
      const id = `session_fake_${++state.counter}`;
      state.sessions[id] = { cwd: params.cwd, mcpUrl: params.mcpServers?.[0]?.url, model: 'kimi-code/k3', thinking: 'high', mode: 'default' };
      saveState(state);
      return { sessionId: id, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }] }, configOptions: configOptions(state.sessions[id]) };
    }
    case 'session/load': {
      const s = state.sessions[params.sessionId];
      if (!s) throw Object.assign(new Error(`Session not found: ${params.sessionId}`), { code: -32602 });
      s.mcpUrl = params.mcpServers?.[0]?.url;
      state.loads++;
      saveState(state);
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED OLD HISTORY' } });
      return { configOptions: configOptions(s) };
    }
    case 'session/set_mode':
    case 'session/set_config_option': {
      const s = state.sessions[params.sessionId];
      if (method === 'session/set_mode') s.mode = params.modeId;
      else if (params.configId === 'model') s.model = params.value;
      else if (params.configId === 'thinking') s.thinking = params.value;
      saveState(state);
      return { configOptions: configOptions(s) };
    }
    case 'session/prompt':
      return prompt(params);
    case 'session/delete':
      delete state.sessions[params.sessionId];
      saveState(state);
      return {};
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'session/cancel') {
    cancelled.add(msg.params.sessionId);
    return;
  }
  if (!msg.method) return;
  handle(msg).then(
    (result) => send({ id: msg.id, result }),
    (err) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } })
  );
});
