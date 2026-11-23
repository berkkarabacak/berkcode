# Claude Agent Runner

Claude Agent Runner lets Claude build a software project for you **step by step, on a schedule**, while you are away.
You use it entirely from your web browser. You never need to type commands.

Every session remembers what the earlier sessions did and carries on from there. You can read what happened in each session, and undo any session with one click.

---

## What you need

- A Windows 10 or Windows 11 computer with an internet connection.
- At least one of the two agents:
  - **Claude**: a Claude API key from the Claude Console (<https://console.anthropic.com/settings/keys>). Claude's work is billed to that account, per use.
  - **Kimi**: a Kimi Code subscription (<https://www.kimi.com/code>). No per-use cost and no API key. Kimi Code CLI must be installed and logged in on the computer; the app can do both for you (Settings → **Kimi Code CLI**).

Nothing else. The app downloads everything else it needs by itself the first time it starts (about 400 MB).

## Claude or Kimi?

You choose the agent **once, when you create a project**. It cannot be changed later; to use the other agent, create a new project.

| | Claude | Kimi |
| --- | --- | --- |
| How it is paid | Your Anthropic API key, per use | Your Kimi Code subscription, no per-use cost |
| Model | Claude Sonnet 5.5 by default (changeable) | Best available Kimi model (K3.1 Pro) with Max thinking by default (changeable) |
| Limits per session | Steps, time and money | Steps and time |
| Memory, schedules, live view, Stop, restore points, run history | ✓ | ✓ (identical) |

Both agents use the same memory system: every session reads what earlier sessions recorded (brief, plan, progress, decisions, notes) and writes down what it did.

If you use Kimi: Settings → **Kimi Code CLI** shows whether Kimi is installed and logged in, and which model new projects will use, with **Install Kimi Code CLI** / **Log in to Kimi** buttons when something is missing. If K3.1 Pro is missing from the list, press **Log in to Kimi again** to refresh it.

## Start the app

1. If you received the app as a **ZIP file**: right-click the ZIP file → **Properties** → tick **Unblock** (if you see it) → **OK**. Then right-click it again → **Extract All…** → **Extract**.
2. Open the extracted folder and double-click **`start.bat`**.
   - If Windows asks "Do you want to run this file?" or shows "Windows protected your PC", click **Run** (or **More info** → **Run anyway**).
3. The first start takes a few minutes while the app downloads what it needs. A black window shows what is happening.
4. Your browser opens the app. The black window closes by itself. **The app keeps running in the background.**

A **Claude Agent Runner** icon is added to your desktop. Use it to open the app from now on.

While the app runs, its icon also sits **next to the clock**. Windows may hide new icons behind the small arrow (**^**); drag it from there onto the taskbar to always see it.

| Icon next to the clock | Meaning |
| --- | --- |
| App icon | Running, waiting for the next scheduled session (hover over it to see when) |
| With a **blue** dot | Working on a project right now |
| With a **red** dot | Something needs your attention: click it and the app shows what |
| No icon | The app is not running: double-click the desktop icon |

Click the icon to open the app; right-click it to turn *Start with Windows* on or off, or to quit the app.

> Tip: if you put a file called `claudeapi.key` containing your API key next to `start.bat`, the app picks the key up automatically.

## First-time setup (about 2 minutes)

1. For Claude: **Settings** → paste your API key → press **Test key**. When it says "The key works and has been saved", you are done.
   For Kimi: **Settings** → **Kimi Code CLI** shows whether Kimi is ready. If it is not, press **Install Kimi Code CLI** or **Log in to Kimi**: a window opens and guides you (the login confirms a code on a Kimi web page).
2. **Projects** → **+ Add project**:
   1. Give it a name, for example *My website*.
   2. Choose **who should do the work**: Claude or Kimi.
   3. A folder is suggested for you inside the app's **`projects`** folder, so the project moves along if you ever copy the app to another computer. You can press **Browse…** to choose another one.
   4. Describe in your own words what should be built.
   5. Choose when it should work on it: **Repeat every** 15 or 30 minutes or 1–12 hours, **every day** at a set time, or **on selected weekdays**. You can change this later in the **Schedule** tab.
3. Press **Run now** to start the first session right away and watch it in the **Live** tab.

## Every day

| Where | What you can do |
| --- | --- |
| **Projects** | See each project's next run, last result and cost. **Run now**, **Pause schedule**, **Open**. |
| **Runs** tab | Every session: the agent's own summary, which files changed, the full log. **Restore folder to before this run** undoes a session. |
| **Live** tab | Watch the current session. **Stop** ends it safely. |
| **Memory** tab | **Brief** (what to build), **Plan** (a checklist you can edit), **Progress** (one note per session), notes, search, history of every change. |
| **Schedule** tab | Change when the agent works (for example from every 30 minutes to every 2 hours), or pause it. |
| **Setup** tab | Name, folder, instructions, model, limits. **Open folder** and **Open website** buttons are at the top. |

**To steer the agent**, edit the **Brief** or the **Plan** between sessions. The next session follows your changes.

**Scheduled sessions only happen while the app is running.** The first time you turn a schedule on, the app asks whether it should start by itself when you log in to Windows: say **Yes**, so a Windows restart (for example an update during the night) does not stop your projects. You can change it later in **Settings** or in the menu of the icon next to the clock. If the computer was off at the scheduled time, the app does that session once when it starts again.

## Safety and cost

- Before every session the app saves a **restore point** of the project folder (the last 5 are kept).
- Each session has limits: **50 steps**, **$5** (Claude only), and **60 minutes** by default (change them in Settings or per project).
- A **monthly budget cap** (default $100) pauses all Claude schedules when it is reached. Kimi projects keep running, because they use your subscription.
- After **3 failed sessions in a row** a project's schedule pauses and the reason is shown.
- The agent only works inside the project folder. Your API key stays in the app folder and never appears in logs or project files.
- The app can only be opened from this computer.

## If something goes wrong

| Problem | What to do |
| --- | --- |
| The page says **"The app is not running"**, or there is no icon next to the clock | Double-click the **Claude Agent Runner** icon on the desktop (or `start.bat`). |
| The icon next to the clock has a **red dot** | Click it to open the app, which shows what needs your attention. (Right-clicking the icon lists it too.) |
| A session failed with **"API key was rejected"** | Settings → paste a fresh key → **Test key**. |
| A session failed with a **billing** message | Add credit in the Claude Console (Billing). |
| A Kimi session failed with **"not logged in"** or **"not installed"** | Settings → **Kimi Code CLI** → **Log in to Kimi** (or **Install Kimi Code CLI**), follow the window, then press **Check again**. |
| A Kimi session failed with **"usage limit"** | Your Kimi subscription's usage window is used up; the next scheduled run tries again. |
| A project says its **folder was not found** | The folder was moved or not copied along. Open the project → **Setup** → **Browse…** to where it is now → **Save**. |
| The agent made a mess | Runs tab → open that run → **Restore folder to before this run**. |
| `start.bat` shows an error | Check the internet connection and start it again. If it keeps failing, send the file `data\logs\setup.log` to whoever gave you the app. |
| Anything else | Settings → **Help & troubleshooting** shows a health check, **Open log folder**, **Restart app** and **Shut down app**. |

## Where things are stored

Everything is inside the app folder (the folder with `start.bat`):

- `projects`: the project folders (new projects are created here).
- `data\app.db`: settings, the API key, projects, run history and all of the agents' memory (copied to `data\db-backups` once a day, last 7 kept).
- `data\backups`: restore points of your project folders.
- `data\logs`: log files for troubleshooting.

The app's own downloads (Node.js, and Git if your computer has none) are in the `runtime` folder. To remove the app completely, shut it down (Settings → Shut down app), then delete its folder and the desktop icon.

If the app folder is inside a **OneDrive** folder, the app installs itself into `%LOCALAPPDATA%\Claude Agent Runner` instead, because syncing would damage its database. The desktop icon opens that copy, and that is the folder to copy when you move the app (Settings shows which folder is in use).

## Moving the app to another computer

The app folder is portable: it contains the app, its settings and API key, the memory and run history of every project, and the project folders in `projects`.

1. **Settings** → **Shut down app**, so everything is saved.
2. Copy the whole app folder to the other computer (USB stick, network, anywhere you like). Settings → *Moving the app to another computer* shows the folder and has an **Open app folder** button.
3. On the other computer, double-click **`start.bat`** in the copied folder. It starts right away, because everything it needs was copied along, and adds the desktop icon there. (Only if that computer has no Git and the app never needed its own copy before, Git is downloaded once.)
4. If you use **Kimi**: Kimi Code CLI is installed per computer, not inside the app folder. Settings → **Kimi Code CLI** → **Install Kimi Code CLI** and log in with your Kimi account. The app shows a reminder until this is done.
5. If *Start the app automatically when I log in to Windows* was on, it is set up on the new computer by itself.

Good to know:

- Projects whose folder is **outside** the app folder (for example older projects in *Documents*) are not copied along. Settings → *Moving the app to another computer* lists them, with a **Move into the app folder** button for each (also in each project's **Setup** tab).
- The first session of each project on the new computer starts a fresh agent session, because the old one remembers the old location. The project memory carries everything over, so the work simply continues.
- Copying the folder to a second place on the same computer gives you an independent second copy; it never takes over the original's desktop icon or Windows startup entry.

---

## Sharing the app with friends

- Share the folder **without** `node_modules`, `runtime`, `data`, `projects` and your `claudeapi.key` (they are excluded from git already). Each person needs **their own API key** (or their own Kimi subscription).
- Zipping the folder and sending it works; so does "Code → Download ZIP" on GitHub.

## For developers

- One Node.js process (`src/server.js`): Express web server on `127.0.0.1`, `croner` scheduler, and a runner built on `@anthropic-ai/claude-agent-sdk`. `src/launcher.js` keeps it running in the background, writes `data/logs`, and restarts it after a crash.
- `scripts/start.ps1` (called by `start.bat`) installs a private Node.js 24 LTS into `runtime/node` (checksum-verified), a portable Git into `runtime/git` when the computer has no Git, runs `npm ci`, and starts the launcher hidden.
- Storage is Node's built-in `node:sqlite` with FTS5, so nothing needs compiling.
- Memory lives in SQLite. The Agent SDK cannot plug its native memory tool into custom storage, so the agent gets an MCP tool `memory` (view / create / str_replace / insert / delete / rename, the same semantics as Anthropic's memory tool) plus `memory_search` (`src/memory.js`, `src/memoryTools.js`). Claude Code's own auto-memory is turned off, and the agent's config and transcripts live in `data/agent`.
- `src/runner.js` holds the run lifecycle shared by both agents; `src/agents/claude.js` and `src/agents/kimi.js` only run the conversation.
- **Claude** runs in-process through the Agent SDK with streaming input, so Stop and the time limit interrupt the agent gracefully and still report cost. On a resumed session the SDK reports cost cumulatively, and the runner subtracts what was spent before.
- **Kimi** runs as `kimi acp` (Agent Client Protocol over stdio, `src/agents/kimi.js`). The memory tools are attached per session as an HTTP MCP server served by the app itself at `/mcp/<one-time token>` (`src/mcpHttp.js`), so nothing is written to Kimi's config or the project folder and the tool names match Claude's (`mcp__agent_memory__memory`). Sessions continue with `session/load`, Stop uses `session/cancel`, and runs use Never Ask mode. Kimi's own per-turn step limit ends a turn silently (it reports a normal end), so it is switched off (`KIMI_LOOP_MAX_STEPS_PER_TURN=0`) and the app counts tool calls itself and cancels at the limit. Kimi may end a turn and start another one by itself (for example after a background task), so a session only counts as finished after 10 quiet seconds with no tool running. `test/fixtures/fake-kimi.mjs` stands in for Kimi in the tests.
- Portability: project folders inside the app folder are stored relative to it (`src/projects.js`); folder paths are compared in canonical form (8.3 short names and links resolved, `src/paths.js`); `data/runtime.json` records the app folder, so a copied file never makes one copy mistake another for itself; each project remembers the folder its agent session ran in (`session_folder`) and starts a fresh session when that changes; the desktop icon and the Startup entry are only created or taken over when they are missing or point at a folder that no longer exists. Because people copy the folder while the app runs in the background, the write-ahead log is folded into `app.db` after every idle heartbeat and every run (`checkpoint()` in `src/db.js`), and at startup a damaged database is set aside and replaced by the newest daily backup, with a banner explaining it.
- The icon next to the clock is `scripts/tray.ps1` (Windows PowerShell 5.1 + Windows Forms, so no native modules or compiled binaries). The server starts it (`src/tray.js`) only when it was started by the launcher; it polls `GET /api/tray` every 2 seconds (state, tooltip and menu lines from `src/status.js`) and closes itself when the server process is gone or the icon is switched off in Settings. It is launched through a short-lived `Start-Process`, because Node kills its direct children together with itself (which would leave a dead icon until the mouse passes over it) and Windows PowerShell started as a detached process without a console exits at once. If the icon stops checking in, the server starts it again (at most 4 times an hour). `-SelfTest` builds the icon and menu without showing them.
- Default memory templates are in `src/templates.js`. The standing instructions are in `src/prompt.js`.
- Development: `npm install`, then `node src/launcher.js` (or `node src/server.js --port=4290`). Tests: `npm test`.
