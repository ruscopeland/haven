# How we work — for Rus (no programming knowledge required)

You are the thoughts guy. Claude is the developer. This file is the operating manual
that makes that split work without you getting overwhelmed.

---

## The one habit that prevents disaster

Every session, Claude commits work to **git** (a time machine for the code — it is
already set up). You never lose a working version again. You don't need to learn git;
you just need the magic phrases below.

### Magic phrases (say these to Claude, any model)

| You want | Say |
|---|---|
| Save current state | "Commit everything with a checkpoint message." |
| See recent saves | "Show me the last 10 commits, one line each." |
| Undo uncommitted mess | "Discard all uncommitted changes." |
| Roll back one file | "Restore `<file>` to the last commit." |
| Roll back to a known-good version | "Reset the repo to tag `v0-baseline`" (or `v1-dashboard`, etc.) — **destructive, Claude must confirm first** |
| Back up the database | "Run backup-db.bat" (or double-click it yourself — copies the DB safely to `backups\`, even while the stack runs) |

Tags mark finished, verified milestones: `v0-baseline` (today's working state),
then `v1-dashboard`, `v2-wallet-panels`, `v3-one-app`, `v4-alpha-terminal` as phases land.

**Your private key lives in `crypto-wallet\.env` and `marker-engine\.env` only. Git is
configured to NEVER save those files — so keep your own copy of the key somewhere safe
outside this folder. Git cannot restore it.**

---

## Running a session (copy-paste templates)

### 🔧 Normal work session (cheaper models are fine)
> Read CLAUDE.md, ROADMAP.md and WORKFLOW.md. Execute task **B1** from ROADMAP.md and
> nothing else. Follow the Execution rules at the top of ROADMAP.md exactly. Commit when
> done and mark the task `[x]` in ROADMAP.md.

Change "B1" to whichever task is next unchecked. One task per session — that is what
keeps cheap models from wandering off and breaking things.

### 🧠 Fable 5 session (spend these on judgment, not typing)
Use your strongest-model prompts ONLY for tasks marked 🧠 in the roadmap:
> Read CLAUDE.md, ROADMAP.md and WORKFLOW.md. Do 🧠 task **B4** (review checkpoint):
> review `git diff v0-baseline` for the issues listed in the task, fix what you find,
> update ROADMAP.md, commit, and tag as specified.

### 🚑 Something broke
> The app broke after the last session. Show me the last 5 commits. Diagnose what the
> last commit changed, and either fix forward or revert that commit. Do not touch
> anything else.

### Budget rule of thumb
- 🔧 tasks: written so precisely that a cheaper model mostly types. If it starts
  improvising ("I also refactored…"), stop it and say: "Revert everything not required
  by the task."
- 🧠 tasks: phase kickoffs, reviews, anything touching money paths. Worth Fable tokens
  because a wrong decision there costs more sessions than it saves.
- Never let any model work without committing first. The commit is your insurance.

---

## What's safe and what's not (so you can relax)

- The **trading engine, collector, and API are separate programs** in their own windows.
  UI work (Phases A–C) cannot break trading — worst case a web page looks wrong.
- The old **wallet app keeps running untouched** until the new Dashboard proves itself
  (Phase D). You always have the familiar screen as fallback.
- The **database is NOT in git** (too big, always changing). `backup-db.bat` is its
  safety net — run it before any session that touches `crypto-data-collector`.
- Real-money changes (task C3, anything in `marker-engine`) are 🧠-only and get tested
  with $5 first. That's in the task definitions.

## Updating the program after people subscribe (future, Phase F)

Git already gives you the release mechanism: subscribers run a tagged version
(`v4-alpha-terminal`), you develop past it, and "releasing" = testing + moving the tag.
Nothing to decide today; the habit you're building now IS the release process later.
