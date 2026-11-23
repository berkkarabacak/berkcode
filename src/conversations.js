// Conversations as the owner sees them in the chat: the runs of one agent session, scheduled ones and chat
// messages alike (see runs.conversation_id).
import { db } from './db.js';

const plain = (s) => String(s ?? '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim();
const shorten = (s, max = 56) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** A short title from a summary: its first sentence, without filler such as "This session". */
function titleFromSummary(summary) {
  const line = plain(summary.split('\n').find((l) => plain(l)) ?? '');
  let title = line.split(/(?<=[.!?])\s/)[0].replace(/[.!?:;,]+$/, '').replace(/,\s*(including|with|and)$/i, '');
  title = title.replace(/^(in )?this session,?\s+/i, '').replace(/^i\s+/i, '');
  return title ? title[0].toUpperCase() + title.slice(1) : '';
}

/** The first message the owner wrote, or else the first line of the agent's first summary. */
export function conversationTitle(conversationId) {
  const asked = db
    .prepare('SELECT user_message FROM runs WHERE conversation_id = ? AND user_message IS NOT NULL ORDER BY id LIMIT 1')
    .get(conversationId);
  if (asked) return shorten(plain(asked.user_message.split('\n').find((l) => l.trim()) ?? '') || 'Chat');
  const summed = db
    .prepare("SELECT summary FROM runs WHERE conversation_id = ? AND summary IS NOT NULL AND TRIM(summary) != '' ORDER BY id LIMIT 1")
    .get(conversationId);
  if (summed) {
    const title = titleFromSummary(summed.summary);
    if (title) return shorten(title);
  }
  return 'Scheduled session';
}

/** All conversations of a project, most recently active first. */
export function listConversations(projectId, activeConversationId = null) {
  const rows = db
    .prepare(
      `SELECT conversation_id AS id, COUNT(*) AS runs, MIN(started_at) AS started_at,
              MAX(COALESCE(ended_at, started_at)) AS last_active, MAX(id) AS last_run,
              SUM(CASE WHEN user_message IS NOT NULL THEN 1 ELSE 0 END) AS messages
       FROM runs WHERE project_id = ? AND conversation_id IS NOT NULL
       GROUP BY conversation_id ORDER BY MAX(id) DESC`
    )
    .all(Number(projectId));
  const statusOf = db.prepare('SELECT status FROM runs WHERE id = ?');
  return rows.map((c) => ({
    id: c.id,
    title: conversationTitle(c.id),
    runs: c.runs,
    started_at: c.started_at,
    last_active: c.last_active,
    last_status: statusOf.get(c.last_run)?.status ?? null,
    running: c.id === activeConversationId,
    has_messages: c.messages > 0,
  }));
}

/** The runs of a conversation, oldest first; at most `limit`, ending before run `before` (for "load earlier"). */
export function conversationRuns(projectId, conversationId, { before = null, limit = 30 } = {}) {
  const params = [Number(projectId), Number(conversationId)];
  let sql = 'SELECT * FROM runs WHERE project_id = ? AND conversation_id = ?';
  if (before) {
    sql += ' AND id < ?';
    params.push(Number(before));
  }
  const runs = db.prepare(`${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit).reverse();
  const earlier = runs.length
    ? db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND conversation_id = ? AND id < ?').get(Number(projectId), Number(conversationId), runs[0].id).n
    : 0;
  return { runs, earlier };
}
