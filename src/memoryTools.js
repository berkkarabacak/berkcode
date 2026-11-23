import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { memoryStore } from './memory.js';

// The same two tools are offered to every agent: in-process for Claude, over HTTP (src/mcpHttp.js) for Kimi.
// Both agents name MCP tools mcp__<server>__<tool>, so the names below are identical for Claude and Kimi.
export const MEMORY_SERVER = 'agent_memory';
export const MEMORY_TOOL = `mcp__${MEMORY_SERVER}__memory`;
export const SEARCH_TOOL = `mcp__${MEMORY_SERVER}__memory_search`;

export const MEMORY_DESCRIPTION = `Your persistent memory for this project. It survives between sessions; anything not written here may be lost.
All paths live under /memories. Commands (same semantics as Anthropic's memory tool):
- view: show a directory listing (up to 2 levels) or a file with line numbers. Optional view_range [start, end] (end -1 = to the end).
- create: create or overwrite a file with file_text.
- str_replace: replace old_str (must occur exactly once) with new_str in a file.
- insert: insert insert_text after line insert_line (0 = beginning of file).
- delete: delete a file or directory (the /memories root cannot be deleted).
- rename: move/rename old_path to new_path (destination must not exist).
Keep memory organised and up to date. Never store secrets or API keys.`;

export const SEARCH_DESCRIPTION =
  'Full-text search over all memory entries of this project. Returns matching entry paths with snippets. Use it to find earlier notes, decisions or progress entries.';

export const memoryInputShape = {
  command: z.enum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename']),
  path: z.string().optional().describe('Path under /memories (all commands except rename)'),
  view_range: z.array(z.number().int()).length(2).optional().describe('[start_line, end_line] for view'),
  file_text: z.string().optional().describe('Full file content for create'),
  old_str: z.string().optional().describe('Exact text to replace for str_replace'),
  new_str: z.string().optional().describe('Replacement text for str_replace'),
  insert_line: z.number().int().optional().describe('Line number to insert after for insert (0 = beginning)'),
  insert_text: z.string().optional().describe('Text to insert for insert'),
  old_path: z.string().optional().describe('Source path for rename'),
  new_path: z.string().optional().describe('Destination path for rename'),
};

export const searchInputShape = {
  query: z.string().describe('Words to search for'),
  limit: z.number().int().min(1).max(50).optional(),
};

/** Tool handlers bound to one project. changedBy is recorded in version history; onWrite gets every written path. */
export function memoryHandlers(projectId, { changedBy, onWrite }) {
  const store = memoryStore(projectId, { changedBy, onWrite });
  return {
    async memory(args) {
      const { text, isError } = store.execute(args);
      return { content: [{ type: 'text', text }], isError };
    },
    async search({ query, limit }) {
      const results = store.search(query, limit ?? 10);
      const text = results.length
        ? results.map((r) => `${r.path}\n  ${String(r.snippet).replace(/\n/g, ' ')}`).join('\n')
        : `No memory entries match "${query}".`;
      return { content: [{ type: 'text', text }] };
    },
  };
}

/** Builds the in-process MCP server used by Claude runs (Claude Agent SDK). */
export function createMemoryServer(projectId, { changedBy, onWrite }) {
  const handlers = memoryHandlers(projectId, { changedBy, onWrite });
  return createSdkMcpServer({
    name: MEMORY_SERVER,
    version: '1.0.0',
    tools: [
      tool('memory', MEMORY_DESCRIPTION, memoryInputShape, handlers.memory, {
        annotations: { openWorldHint: false, destructiveHint: false },
        alwaysLoad: true,
      }),
      tool('memory_search', SEARCH_DESCRIPTION, searchInputShape, handlers.search, {
        annotations: { readOnlyHint: true, openWorldHint: false },
        alwaysLoad: true,
      }),
    ],
    alwaysLoad: true,
  });
}
