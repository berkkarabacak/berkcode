import { MEMORY_SERVER } from './memoryTools.js';

export const clip = (text, max = 1200) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters]` : s;
};

export function describeToolUse(name, input = {}) {
  if (name === `mcp__${MEMORY_SERVER}__memory`) {
    const target = input.command === 'rename' ? `${input.old_path} → ${input.new_path}` : input.path ?? '/memories';
    let detail = '';
    if (input.command === 'create') detail = `\n${clip(input.file_text, 600)}`;
    if (input.command === 'str_replace') detail = `\n- ${clip(input.old_str, 300)}\n+ ${clip(input.new_str, 300)}`;
    if (input.command === 'insert') detail = ` (after line ${input.insert_line})\n${clip(input.insert_text, 600)}`;
    return { type: 'memory', content: `Memory ${input.command}: ${target}${detail}` };
  }
  if (name === `mcp__${MEMORY_SERVER}__memory_search`) return { type: 'memory', content: `Memory search: "${input.query}"` };
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { type: 'tool', content: `${name === 'Bash' ? '$' : 'PS>'} ${clip(input.command, 800)}${input.description ? `   # ${input.description}` : ''}` };
    case 'Read':
      return { type: 'tool', content: `Read ${input.file_path}` };
    case 'Write':
      return { type: 'tool', content: `Write ${input.file_path} (${String(input.content ?? '').split('\n').length} lines)` };
    case 'Edit':
    case 'MultiEdit':
      return { type: 'tool', content: `Edit ${input.file_path}` };
    case 'Glob':
      return { type: 'tool', content: `Find files ${input.pattern}${input.path ? ` in ${input.path}` : ''}` };
    case 'Grep':
      return { type: 'tool', content: `Search "${input.pattern}"${input.path ? ` in ${input.path}` : ''}` };
    case 'WebFetch':
      return { type: 'tool', content: `Fetch ${input.url}` };
    case 'WebSearch':
      return { type: 'tool', content: `Web search "${input.query}"` };
    case 'TodoWrite':
      return {
        type: 'tool',
        content: `Todo list:\n${(input.todos ?? []).map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`).join('\n')}`,
      };
    case 'Task':
    case 'Agent':
      return { type: 'tool', content: `Sub-agent: ${input.description ?? ''}` };
    default:
      return { type: 'tool', content: `${name} ${clip(JSON.stringify(input), 400)}` };
  }
}

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return '';
}

/** Converts one SDK message into zero or more readable log entries. */
export function formatMessage(msg) {
  const out = [];
  if (msg.parent_tool_use_id) return out;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        out.push({
          type: 'system',
          content: `Agent started · model ${msg.model} · session ${msg.session_id} · credential: ${msg.apiKeySource}`,
        });
      } else if (msg.subtype === 'compact_boundary') {
        out.push({ type: 'system', content: 'Conversation was compacted to free up context.' });
      } else if (msg.subtype === 'api_retry') {
        out.push({
          type: 'warning',
          content: `API error (${msg.error ?? msg.error_status ?? 'connection'}), retrying in ${Math.round((msg.retry_delay_ms ?? 0) / 1000)}s (attempt ${msg.attempt}/${msg.max_retries})…`,
        });
      }
      break;
    case 'assistant':
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) out.push({ type: 'assistant', content: block.text });
        else if (block.type === 'tool_use') out.push(describeToolUse(block.name, block.input));
      }
      if (msg.error) out.push({ type: 'error', content: `API error: ${msg.error}` });
      break;
    case 'user':
      if (Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            out.push({ type: block.is_error ? 'tool_error' : 'tool_result', content: clip(toolResultText(block), 1500) });
          }
        }
      }
      break;
    case 'result': {
      const cost = typeof msg.total_cost_usd === 'number' ? `$${msg.total_cost_usd.toFixed(4)}` : '?';
      const label = msg.subtype === 'success' && !msg.is_error ? 'Finished' : `Ended (${msg.subtype})`;
      out.push({ type: 'result', content: `${label} · ${msg.num_turns} steps · ${cost} · ${Math.round((msg.duration_ms ?? 0) / 1000)}s` });
      if (msg.errors?.length) out.push({ type: 'error', content: msg.errors.join('\n') });
      break;
    }
    default:
      break;
  }
  return out;
}
