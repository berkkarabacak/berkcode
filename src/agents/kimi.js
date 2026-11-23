// Runs one Kimi session by driving Kimi Code CLI in ACP mode ("kimi acp"), using the owner's Kimi subscription.
// The project memory is attached to the session as an MCP server over HTTP (see src/mcpHttp.js).
import { spawn } from 'node:child_process';
import { JsonRpcConnection } from './jsonrpc.js';
import {
  ACP_CLIENT_CAPABILITIES, kimiCommand, pickKimiModel, modelOptionsFrom, currentOptionValue, isAuthError, killTree, invalidateKimiStatus,
} from './kimiInfo.js';
import { grantMemoryAccess } from '../mcpHttp.js';
import { MEMORY_SERVER, MEMORY_TOOL, SEARCH_TOOL } from '../memoryTools.js';
import { describeToolUse, clip } from '../logFormat.js';
import { redact } from '../redact.js';

const MEMORY_COMMANDS = new Set(['view', 'create', 'str_replace', 'insert', 'delete', 'rename']);
/** Session updates that mean the agent is actively working (others, such as command lists, are just status). */
const ACTIVITY_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
/**
 * Kimi can end a turn and immediately start another one by itself (for example when a background task
 * finishes). A session therefore only counts as finished once it has been quiet for this long.
 */
const QUIET_MS = Number(process.env.RUNNER_KIMI_QUIET_MS) || 10_000;

/** Extra rule for Kimi: its background tasks split work across turns, which unattended runs must avoid. */
export const KIMI_RULES = '- Do not run commands as background tasks (no run_in_background, TaskOutput or TaskStop). Run them in the foreground and give long commands a timeout, for example: timeout 120 <command>.';

/** Turns a Kimi error into a plain-language message. */
export function explainKimiError(err, model) {
  const msg = String(err?.message ?? err ?? 'unknown error');
  if (isAuthError(err)) {
    return { code: 'auth', fatal: true, text: 'Kimi Code CLI is not logged in on this computer. Open Settings and press "Log in to Kimi" (or run "kimi login" in PowerShell), then start the run again.' };
  }
  if (/quota|usage limit|rate.?limit|\b429\b|too many requests|insufficient|exhaust/i.test(msg)) {
    return { code: 'usage_limit', fatal: false, text: 'Your Kimi subscription usage limit is reached for now. The next run will try again later.' };
  }
  if (model && /\b40[13]\b|not (available|allowed|permitted)|entitle|membership|plan/i.test(msg)) {
    return { code: 'model', fatal: true, text: `Your Kimi plan could not use the model "${model}". Choose another model in the project's Setup tab.` };
  }
  return { code: 'error', fatal: false, text: `Kimi Code CLI reported a problem: ${redact(msg)}` };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
      return 'success';
    case 'max_turn_requests':
      return 'max_turns';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'error';
  }
}

/** Kimi announces a tool call first and fills in its input in later updates; an empty object means "not yet". */
const hasInput = (input) => Boolean(input && typeof input === 'object' && Object.keys(input).length > 0);

function describeKimiTool(call) {
  const input = hasInput(call.rawInput) ? call.rawInput : {};
  const title = String(call.title ?? '');
  const memoryPath = String(input.path ?? input.old_path ?? '');
  if (/memory_search/.test(title) || (/agent_memory/.test(title) && input.query)) return describeToolUse(SEARCH_TOOL, input);
  if (/agent_memory/.test(title) || (MEMORY_COMMANDS.has(input.command) && memoryPath.startsWith('/memories'))) {
    return input.command ? describeToolUse(MEMORY_TOOL, input) : { type: 'memory', content: 'Memory tool' };
  }
  const command = input.command ?? input.cmd;
  if ((call.kind === 'execute' || /^(bash|shell|powershell)/i.test(title)) && typeof command === 'string') return { type: 'tool', content: `$ ${clip(command, 800)}` };
  const location = call.locations?.[0]?.path;
  // Kimi's titles may write a path with / where the input has \ (or the other way round): compare them alike.
  const same = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const detail = [input.path, input.file_path, input.pattern, input.query, input.url, location].find(
    (v) => typeof v === 'string' && v && !same(title).includes(same(v)) && !same(title).includes(same(v).split('/').pop())
  );
  const label = `${title || call.kind || 'tool'}${detail ? ` ${detail}` : ''}`;
  return { type: 'tool', content: clip(label, 600) };
}

function toolResultText(update) {
  const parts = [];
  for (const c of update.content ?? []) {
    if (c.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
    else if (c.type === 'diff') parts.push(`Changed ${c.path}`);
  }
  if (!parts.length && update.rawOutput != null) parts.push(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput));
  return parts.join('\n').trim();
}

/**
 * Runs one Kimi session. Returns a result in the shape shared by all agents:
 * { sessionId, resumed, resumeFailedReason, outcomes[], summary, turns, error, fatal, costTotal (null), model }.
 */
export async function runKimiConversation({ ctx, projectId, folder, limits, prompt, freshPrompt = prompt, resumeId, runId, log, memoryWritten, onTurnEnd }) {
  const out = { sessionId: null, resumed: false, resumeFailedReason: null, outcomes: [], summary: null, turns: 0, error: null, fatal: false, costTotal: null, model: limits.model ?? null };
  const cmd = kimiCommand();
  if (!cmd) {
    out.fatal = true;
    out.error = 'Kimi Code CLI is not installed on this computer. Open Settings and press "Install Kimi Code CLI", then start the run again.';
    return out;
  }

  const grant = grantMemoryAccess({ projectId, changedBy: `run #${runId}`, onWrite: (p) => memoryWritten.add(p) });
  const mcpServers = [{ type: 'http', name: MEMORY_SERVER, url: grant.url, headers: [] }];
  const env = {
    ...process.env,
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_DISABLE_CRON: '1',
    // Kimi's own step limit ends a turn silently (it reports a normal end), so the app enforces the limit itself.
    KIMI_LOOP_MAX_STEPS_PER_TURN: '0',
  };
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH && !env.KIMI_SHELL_PATH) env.KIMI_SHELL_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH;

  const child = spawn(cmd.command, [...cmd.args, 'acp'], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stderrTail = [];
  child.stderr.on('data', (d) => {
    stderrTail.push(String(d));
    if (stderrTail.length > 30) stderrTail.shift();
  });

  let sessionId = null;
  let replaying = false;
  let textBuffer = '';
  let lastFlush = Date.now();
  let lastAssistant = '';
  // The step limit counts the steps (tool calls) of each piece of work: the first prompt and every message from
  // the owner. The short progress-note turn is exempt.
  let limitActive = true;
  let stepsThisTurn = 0;
  let forcedLimit = false;
  let planText = '';
  let lastActivity = Date.now();
  const openCalls = new Set();
  const calls = new Map();

  /** Resolves once Kimi has no tool running and has been quiet for QUIET_MS (or the run is being stopped). */
  const waitUntilIdle = async () => {
    while (!ctx.stopReason && !rpc.closed) {
      if (openCalls.size === 0 && Date.now() - lastActivity >= QUIET_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const flush = () => {
    const text = textBuffer.trim();
    if (text) {
      log('assistant', text);
      lastAssistant = text;
    }
    textBuffer = '';
    lastFlush = Date.now();
  };
  const flushTimer = setInterval(() => {
    if (textBuffer.trim() && Date.now() - lastFlush > 2500 && /[\n.!?:]\s*$/.test(textBuffer)) flush();
  }, 1000);

  const logCall = (id) => {
    const call = calls.get(id);
    if (!call || call.logged) return;
    call.logged = true;
    const entry = describeKimiTool(call);
    log(entry.type, entry.content);
  };

  const onNotification = (method, params) => {
    if (method !== 'session/update' || replaying) return;
    const u = params?.update;
    if (!u) return;
    if (ACTIVITY_UPDATES.has(u.sessionUpdate)) lastActivity = Date.now();
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') textBuffer += u.content.text;
        break;
      case 'tool_call': {
        flush();
        out.turns++;
        stepsThisTurn++;
        if (u.status !== 'completed' && u.status !== 'failed') openCalls.add(u.toolCallId);
        calls.set(u.toolCallId, { ...u, logged: false });
        if (hasInput(u.rawInput)) logCall(u.toolCallId);
        if (limitActive && stepsThisTurn > limits.maxTurns && !forcedLimit && !ctx.stopReason) {
          forcedLimit = true;
          log('warning', `The step limit (${limits.maxTurns} steps) was reached, so the session is being stopped.`);
          if (sessionId) rpc.notify('session/cancel', { sessionId });
        }
        break;
      }
      case 'tool_call_update': {
        const call = calls.get(u.toolCallId);
        if (call) {
          if (hasInput(u.rawInput)) call.rawInput = u.rawInput;
          if (u.title) call.title = u.title;
          if (u.kind) call.kind = u.kind;
          if (u.locations) call.locations = u.locations;
        }
        if (u.status !== 'completed' && u.status !== 'failed') {
          if (hasInput(call?.rawInput)) logCall(u.toolCallId);
          break;
        }
        openCalls.delete(u.toolCallId);
        if (call?.done) break;
        logCall(u.toolCallId);
        if (call) call.done = true;
        const text = toolResultText(u);
        if (text) log(u.status === 'failed' ? 'tool_error' : 'tool_result', clip(text, 1500));
        break;
      }
      case 'plan': {
        const text = (u.entries ?? [])
          .map((e) => `${e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'} ${e.content}`)
          .join('\n');
        if (text && text !== planText) {
          planText = text;
          flush();
          log('tool', `To-do list:\n${text}`);
        }
        break;
      }
      default:
        break;
    }
  };

  const onRequest = async (method, params) => {
    if (method === 'session/request_permission') {
      const options = params?.options ?? [];
      const pick = options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
      if (!pick) return { outcome: { outcome: 'cancelled' } };
      log('system', `Approved automatically: ${clip(params?.toolCall?.title ?? 'an action', 200)}`);
      return { outcome: { outcome: 'selected', optionId: pick.optionId } };
    }
    throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
  };

  const rpc = new JsonRpcConnection(child, { onRequest, onNotification });
  ctx.conversation = {
    interrupt: () => {
      if (sessionId) rpc.notify('session/cancel', { sessionId });
    },
  };
  const onAbort = () => killTree(child);
  ctx.abort.signal.addEventListener('abort', onAbort);

  const fail = (err) => {
    const e = explainKimiError(err, out.model);
    out.error = e.text;
    out.fatal = e.fatal;
    if (e.code === 'auth') invalidateKimiStatus();
    const tail = stderrTail.join('').trim();
    if (e.code === 'error' && tail) out.error += `\n${redact(tail.split('\n').slice(-3).join('\n'))}`;
  };

  try {
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: ACP_CLIENT_CAPABILITIES }, 60_000);

    let configOptions = null;
    if (resumeId) {
      replaying = true;
      try {
        const loaded = await rpc.request('session/load', { sessionId: resumeId, cwd: folder, mcpServers }, 180_000);
        sessionId = resumeId;
        out.resumed = true;
        configOptions = loaded?.configOptions ?? null;
      } catch (err) {
        if (isAuthError(err)) throw err;
        out.resumeFailedReason = err.message;
        log('warning', `The previous Kimi session could not be continued (${redact(err.message)}). Starting a fresh session instead; memory carries the project state.`);
      } finally {
        replaying = false;
      }
    }
    if (!sessionId) {
      const created = await rpc.request('session/new', { cwd: folder, mcpServers }, 120_000);
      sessionId = created.sessionId;
      configOptions = created.configOptions ?? null;
    }
    out.sessionId = sessionId;

    await rpc.request('session/set_mode', { sessionId, modeId: 'auto' }, 30_000).catch((err) => log('warning', `Could not switch Kimi to "Never Ask" mode: ${err.message}`));

    const offered = modelOptionsFrom(configOptions);
    if (!out.resumed) {
      // Model and thinking effort are chosen when a session starts; switching them inside a session hurts quality.
      const wanted = limits.model || pickKimiModel(offered.map((m) => m.id));
      if (wanted && offered.some((m) => m.id === wanted)) {
        await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: wanted }, 30_000);
        out.model = wanted;
      } else {
        out.model = currentOptionValue(configOptions, 'model');
        if (wanted) log('warning', `Kimi does not offer the model "${wanted}" right now, so its default model "${out.model}" is used.`);
      }
      if (limits.effort) {
        await rpc
          .request('session/set_config_option', { sessionId, configId: 'thinking', value: limits.effort }, 30_000)
          .catch((err) => log('warning', `Could not set the thinking effort to "${limits.effort}": ${err.message}`));
      }
    } else {
      out.model = currentOptionValue(configOptions, 'model') ?? limits.model ?? null;
    }
    const modelName = offered.find((m) => m.id === out.model)?.name ?? out.model ?? 'default';
    log('system', `Kimi ${out.resumed ? 'continues its previous session' : 'started a new session'} · model ${modelName} · thinking ${limits.effort ?? 'default'} · session ${sessionId}`);

    // A fresh session (also when continuing the old one failed) needs the full first prompt with the memory snapshot.
    let text = out.resumed ? prompt : freshPrompt;
    while (text && !ctx.stopReason) {
      stepsThisTurn = 0;
      let response;
      try {
        response = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      } catch (err) {
        flush();
        out.outcomes.push('error');
        fail(err);
        break;
      }
      // Kimi may carry on by itself in a new turn; only judge the session once it has gone quiet.
      const stepsAtAnswer = out.turns;
      lastActivity = Date.now();
      if (!forcedLimit) await waitUntilIdle();
      flush();
      if (out.turns > stepsAtAnswer) log('system', `Kimi kept working on its own for ${out.turns - stepsAtAnswer} more step(s) after its answer.`);
      const outcome = forcedLimit ? 'max_turns' : ctx.stopReason ? 'cancelled' : mapStopReason(response?.stopReason);
      out.outcomes.push(outcome);
      if (outcome === 'success' && out.outcomes.length === 1) out.summary = lastAssistant || null;
      log('result', `${outcome === 'success' ? 'Finished' : 'Ended'} (${response?.stopReason ?? outcome}) · ${out.turns} steps · included in your Kimi subscription`);
      if (outcome === 'error' && !out.error) out.error = `Kimi stopped the session (${response?.stopReason ?? 'unknown reason'}).`;
      const next = outcome === 'success' ? onTurnEnd() : null;
      text = next == null ? null : typeof next === 'string' ? next : next.text;
      limitActive = Boolean(next && typeof next === 'object' && next.limited);
    }
  } catch (err) {
    flush();
    if (!out.outcomes.length) out.outcomes.push('error');
    fail(err);
  } finally {
    clearInterval(flushTimer);
    grant.revoke();
    ctx.abort.signal.removeEventListener('abort', onAbort);
    ctx.conversation = null;
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        killTree(child);
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return out;
}
