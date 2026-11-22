const STANDING_RULES = `## Standing rules
- Work in small, safe steps. One plan step per session is fine.
- Keep the project working after every session.
- Write tests or checks where it makes sense and run them before finishing.
- Prefer simple, well-known tools and libraries.`;

export const BRIEF_TEMPLATE = `# Project brief

## Goal
Describe in a few sentences what this project should become when it is finished.

## Scope
- What is included
- What is explicitly not included

${STANDING_RULES}

## Conventions
- Language / framework:
- How to run the project:
- How to run the tests:
`;

/** Turns a plain-language description typed in the UI into a brief. Text that is already Markdown is kept as is. */
export function buildBrief(description) {
  const text = String(description ?? '').trim();
  if (!text) return BRIEF_TEMPLATE;
  if (/^#\s/m.test(text)) return `${text}\n`;
  return `# Project brief

## Goal
${text}

${STANDING_RULES}
`;
}

export const DEFAULT_TASK_PROMPT = 'Continue building the project described in the brief. Work on the next step of the plan and finish it properly before you stop.';

export const PLAN_TEMPLATE = `# Plan

Status markers: [ ] todo · [~] in progress · [x] done · [!] blocked

- [ ] Plan the work: read the brief and replace these starter steps with 5-10 concrete, small steps for this project
- [ ] Set up the basic project structure
- [ ] Build the first working version of the core feature
- [ ] Add tests or checks for the core feature
- [ ] Write a README explaining how to use the project
`;

export const PROGRESS_TEMPLATE = `# Progress log

One entry per session, oldest first, appended at the end of this file.
Each entry starts with a level-2 heading such as \`## 2026-01-31 14:00 — Added login page\`
and lists what was done, what failed, and the exact next step.
`;

export const DECISIONS_TEMPLATE = `# Decisions

Record each decision with a level-2 heading such as \`## 2026-01-31 — Use SQLite for storage\`,
followed by the decision and the reason for it.
`;

export const STANDARD_ENTRIES = {
  '/memories/brief.md': BRIEF_TEMPLATE,
  '/memories/plan.md': PLAN_TEMPLATE,
  '/memories/progress.md': PROGRESS_TEMPLATE,
  '/memories/decisions.md': DECISIONS_TEMPLATE,
};

export const STANDARD_DIRS = ['/memories/notes'];
