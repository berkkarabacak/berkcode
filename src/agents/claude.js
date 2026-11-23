// Runs one Claude session through the Claude Agent SDK (API key, pay per use).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_HOME, appVersion } from '../paths.js';
import { getSetting } from '../settings.js';
import { redact } from '../redact.js';
import { createMemoryServer, MEMORY_SERVER, MEMORY_TOOL, SEARCH_TOOL } from '../memoryTools.js';
import { SYSTEM_APPEND } from '../prompt.js';
import { formatMessage } from '../logFormat.js';

/** Built-in tools that make no sense in an unattended, scheduled session. */
const DISALLOWED_TOOLS = [
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger',
  'EnterWorktree', 'ExitWorktree', 'SendMessage', 'ListAgents', 'DesignSync', 'Workflow',
];
const FATAL_API_ERRORS = new Set(['authentication_failed', 'billing_error', 'model_not_found', 'oauth_org_not_allowed', 'account_on_hold']);

function explainApiError(code, model) {
  switch (code) {
    case 'authentication_failed':
      return 'The Claude API key was rejected. Open Settings, paste a valid key and press "Test key".';
    case 'billing_error':
      return 'The Anthropic account behind the API key has a billing problem (for example no credit left). Check the Claude Console (console.anthropic.com → Billing).';
    case 'model_not_found':
      return `The model "${model}" is not available for this API key. Choose another model in the project's Setup tab or in Settings.`;
    case 'rate_limit':
      return 'The Anthropic API is limiting requests right now. The app retried several times and then gave up. The next run will try again.';
    case 'overloaded':
    case 'server_error':
      return 'The Anthropic API is overloaded or having problems right now. The app retried several times and then gave up. The next run will try again.';
    case 'account_on_hold':
    case 'oauth_org_not_allowed':
      return 'The Anthropic account cannot be used right now. Check the Claude Console.';
    default:
      return null;
  }
}

/** A tiny async queue used as the streaming prompt, so follow-up messages and interrupts are possible. */
function promptQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      if (closed) return;
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) yield items.shift();
        else if (closed) return;
        else await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

function agentEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    ANTHROPIC_API_KEY: getSetting('api_key'),
    CLAUDE_CONFIG_DIR: AGENT_HOME,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_RETRIES: '4',
    CLAUDE_AGENT_SDK_CLIENT_APP: `claude-agent-runner/${appVersion()}`,
  };
}

const outcomeOf = (result) => {
  if (!result) return 'error';
  if (result.subtype === 'success' && !result.is_error) return 'success';
  if (result.subtype === 'error_max_turns') return 'max_turns';
  if (result.subtype === 'error_max_budget_usd') return 'max_budget';
  return 'error';
};

/**
 * Runs one Claude session. Returns a result in the shape shared by all agents:
 * { sessionId, resumed, resumeFailedReason, outcomes[], summary, turns, error, fatal, costTotal, model }.
 */
export async function runClaudeConversation({ ctx, projectId, folder, limits, prompt, resumeId, runId, log, memoryWritten, onTurnEnd }) {
  const stderrTail = [];

  async function converse(resume) {
    const input = promptQueue();
    input.push(prompt);
    const r = { sessionId: null, results: [], assistantCount: 0, apiError: null, exception: null };
    const q = query({
      prompt: input,
      options: {
        cwd: folder,
        model: limits.model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.budgetUsd,
        resume: resume || undefined,
        abortController: ctx.abort,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { [MEMORY_SERVER]: createMemoryServer(projectId, { changedBy: `run #${runId}`, onWrite: (p) => memoryWritten.add(p) }) },
        allowedTools: [MEMORY_TOOL, SEARCH_TOOL],
        disallowedTools: DISALLOWED_TOOLS,
        strictMcpConfig: true,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
        env: agentEnv(),
        stderr: (data) => {
          stderrTail.push(redact(String(data)));
          if (stderrTail.length > 40) stderrTail.shift();
        },
      },
    });
    ctx.conversation = {
      interrupt: () => {
        q.interrupt().catch(() => {});
        input.close();
      },
    };
    if (ctx.stopReason) ctx.conversation.interrupt();
    try {
      for await (const msg of q) {
        if (msg.session_id) r.sessionId = msg.session_id;
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          r.assistantCount++;
          if (msg.error) {
            r.apiError = msg.error;
            if (FATAL_API_ERRORS.has(msg.error)) input.close();
          }
        }
        for (const entry of formatMessage(msg)) log(entry.type, entry.content);
        if (msg.type === 'result') {
          r.results.push(msg);
          const next = !ctx.stopReason && outcomeOf(msg) === 'success' ? onTurnEnd() : null;
          if (next) input.push(next);
          else input.close();
        }
      }
    } catch (err) {
      r.exception = err;
    } finally {
      input.close();
      ctx.conversation = null;
    }
    return r;
  }

  const out = { sessionId: null, resumed: Boolean(resumeId), resumeFailedReason: null, outcomes: [], summary: null, turns: 0, error: null, fatal: false, costTotal: null, model: limits.model };
  let r = await converse(resumeId);

  const resumeFailed =
    resumeId && !ctx.stopReason && r.assistantCount === 0 && !FATAL_API_ERRORS.has(r.apiError) &&
    (r.exception || r.results.length === 0 || r.results.every((x) => x.is_error));
  if (resumeFailed) {
    out.resumeFailedReason = r.exception?.message || r.results.flatMap((x) => x.errors ?? []).join('; ') || 'unknown reason';
    out.resumed = false;
    log('warning', `The previous session could not be continued (${redact(out.resumeFailedReason)}). Starting a fresh session instead; memory carries the project state.`);
    r = await converse(null);
  }

  out.sessionId = r.sessionId;
  out.outcomes = r.results.map(outcomeOf);
  out.turns = r.results.reduce((sum, x) => sum + (x.num_turns ?? 0), 0);
  const last = r.results.at(-1);
  if (last && typeof last.total_cost_usd === 'number') out.costTotal = last.total_cost_usd;
  const main = r.results[0];
  if (main && outcomeOf(main) === 'success') out.summary = main.result || last?.result || null;

  if (r.apiError && FATAL_API_ERRORS.has(r.apiError)) {
    out.fatal = true;
    out.error = explainApiError(r.apiError, limits.model);
  } else if (!main || outcomeOf(main) === 'error') {
    out.error =
      explainApiError(r.apiError, limits.model) ||
      main?.errors?.filter(Boolean).join('\n') ||
      (main?.is_error ? main.result : null) ||
      r.exception?.message ||
      'The agent stopped unexpectedly.';
    if (!main && stderrTail.length) out.error += `\n${stderrTail.slice(-5).join('').trim()}`;
  }
  return out;
}
