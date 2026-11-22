# Claude Agent Runner

Claude Agent Runner lets Claude build a software project for you **step by step, on a schedule**, while you are away.
You use it entirely from your web browser. You never need to type commands.

Every session remembers what the earlier sessions did and carries on from there. You can read what happened in each session, and undo any session with one click.

---

## What you need

- A Windows 10 or Windows 11 computer with an internet connection.
- A **Claude API key** from the Claude Console: <https://console.anthropic.com/settings/keys>. Claude's work is billed to that account, per use.

Nothing else. The app downloads everything else it needs by itself the first time it starts (about 400 MB).

## Start the app

1. If you received the app as a **ZIP file**: right-click the ZIP file → **Properties** → tick **Unblock** (if you see it) → **OK**. Then right-click it again → **Extract All…** → **Extract**.
2. Open the extracted folder and double-click **`start.bat`**.
   - If Windows asks "Do you want to run this file?" or shows "Windows protected your PC", click **Run** (or **More info** → **Run anyway**).
3. The first start takes a few minutes while the app downloads what it needs. A black window shows what is happening.
4. Your browser opens the app. The black window closes by itself. **The app keeps running in the background.**

A **Claude Agent Runner** icon is added to your desktop. Use it to open the app from now on.

> Tip: if you put a file called `claudeapi.key` containing your API key next to `start.bat`, the app picks the key up automatically.

## First-time setup (about 2 minutes)

1. **Settings** → paste your API key → press **Test key**. When it says "The key works and has been saved", you are done.
2. **Projects** → **+ Add project**:
   1. Give it a name, for example *My website*.
   2. A folder is suggested for you under *Documents\Claude Projects*. You can press **Browse…** to choose another one.
   3. Describe in your own words what Claude should build.
   4. Choose when Claude should work on it, for example *Every day at 09:00*.
3. Press **Run now** to start the first session right away and watch it in the **Live** tab.

## Every day

| Where | What you can do |
| --- | --- |
| **Projects** | See each project's next run, last result and cost. **Run now**, **Pause schedule**, **Open**. |
| **Runs** tab | Every session: Claude's own summary, which files changed, the full log. **Restore folder to before this run** undoes a session. |
| **Live** tab | Watch the current session. **Stop** ends it safely. |
| **Memory** tab | **Brief** (what to build), **Plan** (a checklist you can edit), **Progress** (one note per session), notes, search, history of every change. |
| **Schedule** tab | Change when Claude works, or pause it. |
| **Setup** tab | Name, folder, instructions, model, limits. **Open folder** and **Open website** buttons are at the top. |

**To steer Claude**, edit the **Brief** or the **Plan** between sessions. The next session follows your changes.

**Scheduled sessions only happen while the app is running.** In **Settings**, turn on *Start the app automatically when I log in to Windows* so you don't have to think about it. If the computer was off at the scheduled time, the app does that session once when it starts again.

## Safety and cost

- Before every session the app saves a **restore point** of the project folder (the last 5 are kept).
- Each session has limits: **50 steps**, **$5**, and **60 minutes** by default (change them in Settings or per project).
- A **monthly budget cap** (default $100) pauses all schedules when it is reached.
- After **3 failed sessions in a row** a project's schedule pauses and the reason is shown.
- Claude only works inside the project folder. Your API key stays on this computer and never appears in logs or project files.
- The app can only be opened from this computer.

## If something goes wrong

| Problem | What to do |
| --- | --- |
| The page says **"The app is not running"** | Double-click the **Claude Agent Runner** icon on the desktop (or `start.bat`). |
| A session failed with **"API key was rejected"** | Settings → paste a fresh key → **Test key**. |
| A session failed with a **billing** message | Add credit in the Claude Console (Billing). |
| Claude made a mess | Runs tab → open that run → **Restore folder to before this run**. |
| `start.bat` shows an error | Check the internet connection and start it again. If it keeps failing, send the file `data\logs\setup.log` to whoever gave you the app. |
| Anything else | Settings → **Help & troubleshooting** shows a health check, **Open log folder**, **Restart app** and **Shut down app**. |

## Where things are stored

Everything is in the `data` folder next to `start.bat`:

- `data\app.db`: settings, projects, run history and all of Claude's memory (copied to `data\db-backups` once a day, last 7 kept).
- `data\backups`: restore points of your project folders.
- `data\logs`: log files for troubleshooting.

The app's own downloads (Node.js, and Git if your computer has none) are in the `runtime` folder. To remove the app completely, shut it down (Settings → Shut down app), then delete its folder and the desktop icon.

If the app folder is inside a **OneDrive** folder, the app installs itself into `%LOCALAPPDATA%\Claude Agent Runner` instead, because syncing would damage its database. The desktop icon opens that copy.

---

## Sharing the app with friends

- Share the folder **without** `node_modules`, `runtime`, `data` and your `claudeapi.key` (they are excluded from git already). Each person needs **their own API key**.
- Zipping the folder and sending it works; so does "Code → Download ZIP" on GitHub.

## For developers

- One Node.js process (`src/server.js`): Express web server on `127.0.0.1`, `croner` scheduler, and a runner built on `@anthropic-ai/claude-agent-sdk`. `src/launcher.js` keeps it running in the background, writes `data/logs`, and restarts it after a crash.
- `scripts/start.ps1` (called by `start.bat`) installs a private Node.js 24 LTS into `runtime/node` (checksum-verified), a portable Git into `runtime/git` when the computer has no Git, runs `npm ci`, and starts the launcher hidden.
- Storage is Node's built-in `node:sqlite` with FTS5, so nothing needs compiling.
- Memory lives in SQLite. The Agent SDK cannot plug its native memory tool into custom storage, so the agent gets an in-process MCP tool `memory` (view / create / str_replace / insert / delete / rename, the same semantics as Anthropic's memory tool) plus `memory_search` (`src/memory.js`, `src/memoryTools.js`). Claude Code's own auto-memory is turned off, and the agent's config and transcripts live in `data/agent`.
- Runs use streaming input, so Stop and the time limit interrupt the agent gracefully and still report cost. On a resumed session the SDK reports cost cumulatively, and the runner subtracts what was spent before.
- Default memory templates are in `src/templates.js`. The standing instructions are in `src/prompt.js`.
- Development: `npm install`, then `node src/launcher.js` (or `node src/server.js --port=4290`). Tests: `npm test`.
