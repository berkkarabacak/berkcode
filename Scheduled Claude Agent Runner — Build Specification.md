# Scheduled Claude Agent Runner — Build Specification

Nov 22, 2026 · @Berk Karabacak

## Goal

Build a small local app that runs a Claude coding agent on a schedule inside a project folder, so a software project is developed step by step without the owner being present.

The owner finds the terminal difficult and wants to do everything from a browser UI: set up a project, write the task, choose a schedule, watch runs, and review results.

The defining requirement is continuity. Every scheduled session must know what earlier sessions did and continue from there. Sessions are not independent jobs; they are consecutive working days on one project.

Success looks like this: the owner configures a project once, leaves it for a week, and comes back to a project folder that has advanced through a coherent sequence of steps, with a readable log in the app of what each session did and what comes next.

## Hard constraints

These are fixed. Do not substitute alternatives.

- **Authentication is a Claude API key only.** The key comes from the Claude Console and is billed per token. Do not use subscription login, OAuth, or `claude login`. The app passes the key to the agent as the `ANTHROPIC_API_KEY` environment variable.
- **Runs on Windows 10/11.** It must install and start without the owner typing terminal commands: provide a `start.bat` that installs dependencies on first launch, starts the server, and opens the browser.
- **The UI is a web page in the browser**, served by the local app at `http://localhost:<port>`. No Electron or native window is required.
- **Do not write an agent loop.** Use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as the engine. It already provides file editing, shell commands, tool use, context management and session resume. The app is a scheduler, a memory manager and a UI around it.
- **Only one model provider: Anthropic.** No multi-provider abstraction in version 1.
- **Verify SDK details against current documentation** at `https://docs.claude.com` before coding. Option names in this spec describe intent; the installed SDK's type definitions are the authority.

* **Agent memory lives in SQLite, accessed through Claude's memory tool.** Do not store memory as files in the project folder, and do not add a vector database, Mem0, Zep, Letta or any other memory product.
* **Git is optional.** The project folder can be any folder. Never require it to be a git repository and never initialise one without the owner asking.

## Architecture and tech stack

One Node.js process contains everything: web server, scheduler and agent runner. There is no separate database server or background service.

| Part | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 20 or newer | The owner installs Node.js and Git for Windows once; `start.bat` checks for both and shows a clear message if missing |
| Language | TypeScript or plain JavaScript | Keep the build step trivial or absent |
| Web server | Express or Fastify | Bind to `127.0.0.1` only |
| Agent engine | `@anthropic-ai/claude-agent-sdk` | Called in-process through its `query()` function |
| Scheduler | `node-cron` or equivalent | In-process, timezone-aware, default `Europe/Istanbul` |
| Storage | SQLite | One database file for settings, projects, runs and agent memory. Use Node's built-in SQLite module or a package with prebuilt Windows binaries, so no C++ compiler is needed |
| Frontend | Single-page UI, plain HTML/JS or a light framework | Served as static files by the same server |
| Live updates | Server-Sent Events | Streams run output to the browser |

The scheduler only fires while the app is running. Include an optional setting to start the app automatically at Windows login (a shortcut in the Startup folder or a Task Scheduler entry created by a script).

## Session continuity

Continuity combines three parts: the Agent SDK runs the agent, a SQLite database stores its memory, and Claude's memory tool is the interface the agent uses to read and write that memory. SDK session resume is used on top as a convenience.

Nothing memory-related is written into the project folder, and the project folder does not have to be a git repository.

### Memory store: SQLite

- One SQLite database file in the app's `data` folder holds memory for all projects, scoped by project id.
- Memory is stored as entries, each with a path under `/memories`, text content, and created and updated timestamps.
- Every write keeps the previous version in a history table, so the owner can view and undo changes.
- A full-text index (SQLite FTS5) over entry content supports search. No vector database or embedding model is used.

Each project starts with these entries, created by the app:

| Entry | Purpose | Who writes it |
| --- | --- | --- |
| `/memories/brief.md` | Project goal, scope, standing rules and conventions | Owner writes the first version in the UI |
| `/memories/plan.md` | Roadmap as a list of steps with status: todo, in progress, done, blocked | Owner and agent |
| `/memories/progress.md` | Dated log, one entry per session: what was done, what failed, the exact next step | Agent appends at the end of every run |
| `/memories/decisions.md` | Decisions made and the reasons for them | Agent and owner |
| `/memories/notes/` | Anything else the agent wants to keep, one entry per topic | Agent |

These entries must be sufficient on their own. A brand-new session with no conversation history, given only the project folder and the memory, must be able to continue the work correctly.

### Memory interface: the Claude memory tool

- The agent reads and writes memory through Claude's memory tool. It is a client-side tool: Claude requests an operation and the app executes it. Read the current documentation at `https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool` for the exact command list and schemas.
- Implement a handler for every memory tool command (view, create, edit, insert, delete, rename, or whatever the current documentation lists) that maps each call to the SQLite store for the current project.
- Reject any path outside `/memories` and never let one project's run touch another project's entries.
- **Integration with the Agent SDK:** check whether the installed Agent SDK can enable Anthropic's memory tool with a custom handler. If it can, use that. If it cannot, register a custom tool through the SDK's in-process tool server (`createSdkMcpServer`) that exposes the same commands with the same semantics, and name it in the standing instruction. Either way the storage is the same SQLite handler.
- Add one extra custom tool, `memory_search`, that runs a full-text query and returns matching entry paths with snippets.

### Session resume

- Capture the session id that the SDK reports for each run and store it on the project.
- On the next run, pass that id to the SDK's resume option so the agent keeps its conversational context.
- If resume fails because the session is missing or corrupt, start a fresh session automatically and record that this happened.
- Provide a per-project setting "Start a fresh session every N runs" (default 10) and a manual "Start fresh session" button. Long-resumed sessions get compacted and lose detail, so periodic resets are expected and safe because the memory store carries the state.

### The standing instruction

Every run's prompt is the app's fixed preamble, then a snapshot of memory, then the owner's task prompt.

The app injects the snapshot itself, so the agent starts informed even if it does not look: the full brief, the open plan steps, and the last three progress entries.

The preamble tells the agent to:

1. Check memory before doing anything else, and read further entries as needed.
2. Inspect the project folder to confirm its actual state matches what memory says.
3. Do the next step named in the latest progress entry, or the next unfinished plan step.
4. Run the project's tests or build if they exist.
5. Update the plan step statuses and record any decisions made.
6. Append a dated progress entry covering what was done, what failed, and the exact next step.
7. Stop if blocked, and write the blocker and the question for the owner into the progress entry.

A run that ends without a new progress entry is not marked `success`. The app sends one follow-up turn asking the agent to write it, and marks the run `failed` if it still does not.

## Run lifecycle

A run starts from the schedule or from the "Run now" button and follows the same path either way.

1. **Lock.** If a run is already active for this project, skip and record the run as "skipped: previous run still active". Never run two sessions on one project at once.
2. **Prepare.** Confirm the project folder exists. Create any missing standard memory entries. Refuse to start if no API key is set.
3. **Snapshot.** Take a restore point of the project folder: a git commit if the folder is a git repository and the owner enabled git mode, otherwise a zip backup stored in the app's `data` folder. Keep the last five backups per project.
4. **Build the prompt.** Standing preamble, memory snapshot, then the owner's task prompt.
5. **Start the agent** through the SDK with: working directory set to the project folder; the memory tool and `memory_search` connected to this project's memory; the stored session id for resume, unless a fresh session is due; the configured model; the turn limit and budget limit; and a permission mode that needs no human approval.
6. **Stream.** Write every SDK message to the run's log and forward it to the browser live. Show assistant text and tool calls, including memory operations, in readable form, not raw JSON.
7. **Finish.** From the SDK's final result message, store status, session id, cost in USD, number of turns, duration, and the agent's final summary text. Check that a new progress entry was written.
8. **Record changes.** Store the list of files added, changed and removed during the run, found by comparing the folder before and after, plus the memory entries that were written.
9. **Unlock** in every case, including errors and crashes.

Run statuses: `running`, `success`, `failed`, `stopped`, `skipped`, `limit_reached`.

If the app was closed during a scheduled time, do not run all the missed sessions on startup. Offer a setting "Run once at startup if a scheduled run was missed" (default on, at most one catch-up run).

## User interface

The UI must be usable by someone who never opens a terminal. Use plain language and no cron syntax by default.

### Dashboard

- A card per project: name, next scheduled run, last run status and time, cost of the last run, total cost this month.
- Buttons on each card: Run now, Pause schedule, Open.
- An "Add project" button.

### Project page

- **Setup tab**
  - Project name.
  - Folder path on this computer, with validation that it exists. A new empty folder is allowed.
  - Task prompt: a large text box for the standing instruction that applies to every session.
  - Model: a dropdown filled from the API's model list, with a sensible default.
  - Restore points: zip backup (default) or git commits, the latter offered only when the folder is already a git repository.
- **Schedule tab**
  - Simple choices: every N hours, daily at a time, selected weekdays at a time. An "Advanced" field accepts a cron expression.
  - Timezone, default `Europe/Istanbul`.
  - Enabled/paused toggle and a display of the next three run times.
- **Memory tab**
  - Brief: rendered Markdown with Edit and Save.
  - Plan: a checklist of steps with status, which the owner can add to, reorder, edit and tick off.
  - Progress: a timeline of session entries, newest first.
  - Decisions and notes: a browsable list of entries, each editable.
  - A search box over all memory.
  - Version history per entry with a Restore button.
  - "Export memory" writes all entries to a folder of Markdown files; "Import memory" reads them back.
  - Current session id, number of runs on it, and a "Start fresh session" button.
- **Runs tab**
  - Table of runs, newest first: start time, trigger (schedule or manual), status, duration, turns, cost, files changed.
  - Clicking a run opens its detail: the agent's final summary, changed files, memory entries written, and the full readable log.
  - A "Restore folder to before this run" button that uses the run's restore point, with a confirmation.
- **Live view**
  - While a run is active, show streaming output and a Stop button that cancels the run cleanly.

### Settings page

- Claude API key: input masked, with a "Test key" button that makes one minimal API call.
- Default model, default turn limit, default budget per run, monthly budget cap.
- Start with Windows on or off.
- Port number.

## Data model and storage

All app data lives in a `data` folder beside the app, never inside the project folders.

| Table | Fields |
| --- | --- |
| Settings | API key, default model, default limits, monthly budget cap, port, start-with-Windows flag |
| Project | id, name, folder path, task prompt, model, schedule definition, timezone, enabled flag, restore-point mode, current session id, runs on current session, fresh-session interval, turn limit, budget per run |
| Run | id, project id, trigger, start time, end time, status, session id, whether the session was resumed or fresh, turns, cost in USD, final summary, changed files, memory entries written, restore point reference, error message |
| Run log | run id, sequence number, timestamp, message type, content |
| Memory entry | id, project id, path, content, created time, updated time |
| Memory history | entry id, previous content, changed time, changed by (agent run id or owner) |

- Everything is in one SQLite file, `data/app.db`, plus zip restore points in `data/backups/`.
- A full-text index covers memory entry content.
- The API key is stored only in the local database, is never written to logs, is never returned in full by any API endpoint, and is never placed in the project folder.
- Back up `app.db` automatically once a day, keeping the last seven copies, since it holds the agent's entire memory.

## Safety, cost and failure handling

The agent runs unattended with permission to edit files and run commands, so limits are part of the core design.

- **Scope.** The agent's working directory is the project folder. The standing preamble forbids changes outside it.
- **Restore points.** Every run starts with a restore point of the project folder, so any run can be undone from the UI. Zip backups skip large dependency folders such as `node_modules` and warn if the folder exceeds a size limit (default 500 MB). In git mode the agent never force-pushes, and pushing to a remote is off by default.
- **Memory safety.** Memory writes are versioned, the memory root cannot be deleted, and paths outside `/memories` are rejected.
- **Cost limits.** Each run has a turn limit (default 50) and a budget in USD (default 5). A monthly cap across all projects pauses every schedule when reached and shows a banner in the UI.
- **Time limit.** A run that exceeds a maximum duration (default 60 minutes) is cancelled and marked `limit_reached`.
- **Repeated failure.** After three consecutive failed runs on a project, pause its schedule and show the reason on the dashboard.
- **API errors.** On rate limit or overload errors, retry with backoff a few times, then fail the run. On an invalid key, fail immediately with a clear message pointing to Settings.
- **Local only.** The server listens on `127.0.0.1`. No remote access, accounts or login in version 1.
- **Secrets.** Never print the API key. Redact anything matching `sk-ant-` in logs and in memory writes.

## Out of scope for version 1

- Other model providers or subscription-based authentication.
- Multiple agents working on one project at the same time, or agents coordinating with each other.
- Remote or mobile access, user accounts, and hosting in the cloud.
- A chat interface for talking to the agent mid-run. The owner steers by editing the task prompt and the state files between runs.
- Pull request creation and GitHub integration.
- Notifications by email or messaging apps.

* Semantic or vector search over memory. Full-text search is enough at this scale.

## Acceptance criteria

The build is done when all of these pass on a Windows machine.

- [ ] Double-clicking `start.bat` on a machine with the prerequisites installed opens the UI in the browser with no terminal input.
- [ ] The owner can enter a Claude API key in Settings, and "Test key" reports success or a clear error.
- [ ] The owner can add a project using a folder that is not a git repository, write a brief and task prompt, and set a daily schedule without typing a cron expression.
- [ ] "Run now" starts a session, output streams live in the browser, and Stop cancels it.
- [ ] A finished run shows status, cost, turns, duration, final summary, changed files and memory entries written.
- [ ] After a run, the Memory tab shows a new dated progress entry with a stated next step, and updated plan step statuses.
- [ ] No memory files appear in the project folder; all memory is in `data/app.db`.
- [ ] A second run resumes the stored session and continues from the next step instead of repeating work.
- [ ] After "Start fresh session", the next run still continues correctly using only the memory store.
- [ ] The owner can edit the plan in the UI, and the next run follows the edited plan.
- [ ] Memory search returns matching entries, and an entry can be restored to an earlier version.
- [ ] "Restore folder to before this run" returns the project folder to its earlier state.
- [ ] A scheduled run fires at the configured time while the app is open, and two runs never overlap on one project.
- [ ] A run that hits the turn, budget or time limit ends cleanly and is marked `limit_reached`.
- [ ] Closing and reopening the app keeps all projects, schedules, session ids, memory and run history.
- [ ] The API key does not appear in any log, API response, memory entry or project folder.

Deliver the source code, a short README for a non-technical Windows user, and default templates for the brief and plan memory entries.
