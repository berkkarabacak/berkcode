import { getEntry, parsePlan, parseProgress } from './memory.js';
import { MEMORY_TOOL, SEARCH_TOOL } from './memoryTools.js';

export const SYSTEM_APPEND = `
You are running unattended as a scheduled session of the "Claude Agent Runner". No human is watching and nobody can answer questions during the run, so never wait for input.
- This computer runs ${process.platform === 'win32' ? 'Windows' : process.platform}. Node.js (node, npm, npx) is available on the PATH.
- Your working directory is the project folder. Never create, modify or delete anything outside it.
- Never start a process that keeps running and never exits (a dev server, a file watcher, "npm start" of a server, a "serve" command) in the foreground: it would block the session until the time limit. If you need one briefly, start it in the background and stop it before you finish.
- Do not leave temporary files (screenshots, scratch scripts, logs) in the project folder. Put them in the system temp folder and delete them when done.
- Never push to a git remote and never force-push. Never initialise a git repository unless the brief asks for it.
- Never print, store or commit API keys or other secrets.
- Your long-term memory is the "${MEMORY_TOOL}" tool (paths under /memories). It is stored by the app, NOT in the project folder. Never write memory files (plan, progress, notes) into the project folder.
- Use "${SEARCH_TOOL}" to search memory by keywords.
- The owner may not be technical. Write progress entries and your final summary in short, plain language.
`;

const preamble = (stamp) => `# Standing instructions for this session

This is one session in a series of scheduled working sessions on the same project. Earlier sessions have already done work; continue from where they stopped. Your memory (the "memory" tool, paths under /memories) is how sessions hand over to each other.

Follow this procedure:
1. Check memory before doing anything else (start with \`view /memories\`), and read further entries as needed. A snapshot is included below for convenience.
2. Inspect the project folder to confirm its actual state matches what memory says. If they disagree, trust the folder and correct memory.
3. Do the next step named in the latest progress entry, or else the next unfinished step in /memories/plan.md. Work on one step at a time and finish it properly. If the plan is still the generic starter plan, first replace it with a concrete list of small steps for this project's brief.
4. Run the project's tests or build if they exist, and fix what you broke.
5. Update step statuses in /memories/plan.md (markers: [ ] todo, [~] in progress, [x] done, [!] blocked) and record any decisions with reasons in /memories/decisions.md. Put other useful knowledge in /memories/notes/<topic>.md.
6. Before you finish, APPEND a dated entry to the end of /memories/progress.md (keep the earlier entries) in exactly this form, using this session's timestamp exactly as written:
   ## ${stamp} — <short title>
   - Done: ...
   - Failed / problems: ...
   - Next step: <the exact next step for the next session>
7. If you are blocked, stop, mark the plan step [!] blocked, and write the blocker and your question for the owner into the progress entry.

A session that ends without a new progress entry counts as failed.
Finish with a short plain-language summary of what you did in this session.`;

function openPlanSteps(content) {
  const steps = parsePlan(content).filter((s) => s.status !== 'done');
  if (!steps.length) return '(no open steps — all plan steps are done or the plan is empty)';
  const label = { todo: '[ ]', in_progress: '[~]', blocked: '[!]' };
  return steps.map((s) => `- ${label[s.status]} ${s.text}`).join('\n');
}

function lastProgress(content, count = 3) {
  const sections = parseProgress(content).slice(-count);
  if (!sections.length) return '(no progress entries yet — this is the first session)';
  return sections.map((s) => `## ${s.title}\n${s.body}`).join('\n\n');
}

export function buildPrompt(project, { now = new Date() } = {}) {
  const brief = getEntry(project.id, '/memories/brief.md')?.content ?? '(missing)';
  const plan = getEntry(project.id, '/memories/plan.md')?.content ?? '';
  const progress = getEntry(project.id, '/memories/progress.md')?.content ?? '';
  const localTime = sessionStamp(project.timezone, now);

  return `${preamble(localTime)}

Current date and time: ${localTime} (${project.timezone}).

# Memory snapshot (taken by the app at session start)

<brief path="/memories/brief.md">
${brief.trim()}
</brief>

<open_plan_steps path="/memories/plan.md">
${openPlanSteps(plan)}
</open_plan_steps>

<latest_progress path="/memories/progress.md">
${lastProgress(progress)}
</latest_progress>

# Task from the owner

${(project.task_prompt || '(no task prompt — follow the brief and plan)').trim()}
`;
}

/** "2026-11-22 21:05" in the project's timezone. */
export function sessionStamp(timezone, now = new Date()) {
  return now.toLocaleString('sv-SE', { timeZone: timezone || 'Europe/Istanbul' }).slice(0, 16);
}

export const progressFollowUp = (stamp) => `You ended the session without appending a new entry to /memories/progress.md. Do that now using the memory tool (append it at the end, keep the earlier entries), in this form:
## ${stamp} — <short title>
- Done: ...
- Failed / problems: ...
- Next step: ...
Also update step statuses in /memories/plan.md if needed. Do not do any other work.`;
