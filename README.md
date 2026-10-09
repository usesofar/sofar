# sofar

Memory for AI coding assistants, kept inside your project.

Works with Claude Code, the Claude desktop app, Codex, Cursor, OpenCode, and
any other tool that reads `AGENTS.md` or speaks MCP.

```
npx sofar.sh
```

Run that in a terminal. It installs sofar and sets up the project you are in,
asking before each step. Other ways to install are under [Install](#install).

## The problem

Every new chat starts from nothing. You explain the project again. You explain
what you already tried and why it did not work. Sooner or later the assistant
suggests the exact approach you ruled out last week, and you spend another
afternoon finding out again that it does not work.

## What sofar does

sofar keeps a written record of the work in your project folder. Your assistant
reads it when a session starts, adds to it while it works, and leaves a
handover note before it stops. The next session picks up where the last one
left off, even in a different tool, on a different machine, weeks later.

The record holds four things:

* **The goal.** What this piece of work is for.
* **The plan.** Tasks grouped into phases, with what is done and what is not.
* **The decisions.** What was chosen, what it was chosen over, and why.
* **The sessions.** What each one did, and the single next action.

The decisions matter most. Knowing that an idea was already tried and rejected
is what stops the same dead end being walked twice.

Everything is plain text that lives in your repo. There is no account and no
server to run. sofar never calls an AI model itself and sends nothing
anywhere. `sofar drive` launches *your* agent under *your* login, so that
agent's usage is yours — `--cost-cap` bounds one run of it.

## Install

```
npx sofar.sh
```

Run it in a terminal. It asks before each step: it installs sofar globally
with its native core, puts the `sofar` command on your PATH, and offers to set
up the repo you are in. When npm's global folder needs sudo, it installs into
`~/.local` instead and offers to add that folder to your shell's startup file.

To install it yourself:

```
npm install -g sofar.sh --allow-scripts=sofar.sh
```

Keep the `-g`. The `npm i sofar.sh` shown on the npm package page installs
sofar into the current folder only, so no `sofar` command appears.

Needs Node 18 or newer. `--allow-scripts=sofar.sh` lets sofar's install
script put the native core in place; npm 12 skips install scripts without it,
and every hook then starts node first. npm 10 and 11 run the script anyway.
On npm 12, `npm config set allow-scripts=sofar.sh --location=user` allows it
for every later install; npm 10 rejects that setting.

If `sofar` is not found after installing, the folder npm puts commands in is
not on your PATH. Add it once, then open a new terminal:

```
echo "export PATH=\"$(npm prefix -g)/bin:\$PATH\"" >> ~/.zshrc
```

Use `~/.bashrc` instead for bash. Update later with `sofar upgrade`.

On macOS (arm64, x64), Linux (x64, arm64) and Windows (x64) the install also
brings a native core, `sofar-core`, that runs the hooks, the statusline and
`sofar status` with no node in front; everywhere else, and with
`SOFAR_CORE=0`, the same commands run in TypeScript with identical output.
`sofar doctor` says which one you are on, and names the npm setting when the
install script was skipped.

To build from a clone of this repo instead:

```
npm install
npm run build
npm install -g ./packages/engine
```

## Get started

```
cd your-project
sofar init
sofar new password-reset --goal "Let users reset a forgotten password"
sofar status
```

`sofar init` sets up the record and connects your tools. It works on the
repo you are in (its git top level, or `--root`). The first time, it asks
which agents to set up (Claude Code, Cursor, Codex), with the ones it finds on
your machine already ticked, and writes files only for those. Without a
terminal it does not guess: it refuses and prints the command to run, so
scripts pass `--agents cursor,codex` or `--agents all`. Run again, it rewires
exactly the agents the repo already has and never adds one you did not pick;
`sofar init --refresh` does that without asking, and `--agents` adds another
agent.

After that, work as usual. In Claude Code the assistant keeps the record
current on its own. Other tools follow a short instruction block that `init`
writes into `AGENTS.md`.

## You can just ask

Once the project is set up you rarely type these commands yourself. Ask your
assistant in ordinary words:

* "Start a new initiative for the password reset work."
* "Where did we get to on this?"
* "Mark the login task done."
* "Record that we went with Postgres over SQLite, and why."
* "Write up this session before you stop."

It runs the right commands and keeps the record in order. The CLI is there for
when you want to look for yourself.

## How a session runs

1. **Start.** The assistant receives the goal, the progress, recent decisions
   and the next action before you type anything.
2. **During.** Decisions and finished tasks get written down as they happen.
   Each commit is stamped with the initiative that produced it, so when work
   reaches the remote — even inside somebody else's push — the session is told
   its work shipped, without anyone having to say so.
3. **Before a phase closes.** `sofar review` hands over what changed, what was
   claimed done, and the rules the work was supposed to keep. Closing runs the
   same questions once more and records anything still outstanding, rather than
   refusing to close.
4. **End.** The assistant writes a summary and the next action. In Claude Code
   a hook holds the session open until it does.

## Sharing with your team

The record is files in git, so it travels with the code.

```
# one person, once
sofar init
git add .sofar .gitattributes .claude .mcp.json CLAUDE.md AGENTS.md
git commit -m "adopt sofar"

# everyone else
npm install -g sofar.sh --allow-scripts=sofar.sh
git pull
sofar status
```

Two branches working on the same initiative will not fight over the record.
Entries are only ever added to the end, never edited, so git keeps both sides
and the result still reads correctly.

## What it plugs into

* **Claude Code**, in the terminal, in the Claude desktop app on Mac and
  Windows, or in the VS Code and JetBrains extensions. `init` wires up the MCP
  server and the hooks. Nothing else to do.
* **Codex, Cursor, OpenCode**, and anything else that reads `AGENTS.md`.
  `init` writes an instruction block there, and those tools follow the same
  loop using the `sofar` command. No extra setup.
* **Any other MCP client.** Point it at `sofar mcp` in its own config to get
  the same twelve tools over stdio.

## Commands

| Command | What it does |
| --- | --- |
| `sofar init` | Set up the record here and connect your tools — asks which agents the first time, or `--agents claude-code,cursor,codex` / `all`; `--refresh` rewires the agents already set up |
| `sofar new <name>` | Start a piece of work and tie it to the current branch — `--supersedes <a>,<b>` when it takes over earlier initiatives, which are closed pointing here |
| `sofar switch <name>` | Point the current branch at a different initiative (reopens it if it was closed) |
| `sofar close [name]` | Mark work finished — `--drop --reason <why>` if it was abandoned, `--superseded-by <name>` if it continues in another initiative — and take every branch off it |
| `sofar status` | Goal, progress, phases, next action (`--watch` for live) |
| `sofar list` | One line per initiative |
| `sofar next` | The next action for every initiative |
| `sofar why <path>` | Every task, session and decision behind a file, across all initiatives |
| `sofar related <task-id>` | Tasks that worked on the same files, ranked by shared paths |
| `sofar review [name]` | The evidence a reviewer needs before a phase closes: what changed, what was claimed, and the rules the work had to keep (`--final` for the close-time pass) |
| `sofar drive [name]` | Work the plan unattended: a fresh agent session per task, each handoff recorded, until a task needs you or the work runs out. `--detach` starts it from inside an agent, `--await` waits for it to need you, `--follow` narrates it, `--stop` ends it |
| `sofar remember <text>` | Keep an operational fact — a release command, a failure mode — where later sessions will find it. `-` reads stdin (a quoted heredoc keeps every quote), `@<file>` a file; `--supersedes <slug> M<n>` replaces an outdated one |
| `sofar statusline --install` | Put the status line in Claude Code's status bar — this repo, or `--user` for every project (`--uninstall` takes it back off) |
| `sofar doctor` | Check the setup and the record: what to fix now (the exit code), and one line counting the history — `--history` lists it, `--json` for scripts, `--explain <id>` for one check |
| `sofar upgrade` | Update sofar itself — sofar tells you when there is something to update to |

Less often needed:

| Command | What it does |
| --- | --- |
| `sofar update-check` | Inspect the update check — what it knows, when it last ran, whether auto-install is on |
| `sofar abandon <branch>` | Stop naming a branch you dropped: its copy of the record leaves the session-start notice, `status` and `list` (`--undo` brings it back, `--list` shows the marks) |
| `sofar export` / `sofar import` | Move events between copies of a record |
| `sofar login`, `link`, `push`, `pull` | Cloud sync, if you turn it on |
| `sofar serve` | Local server with the record as JSON |
| `sofar mcp` | The MCP server, which `init` already registers |
| `sofar statusline` | Renders the line itself — Claude Code calls this, you don't |
| `sofar event append` | Write one entry by hand; `--payload -` reads the JSON from stdin, `--payload @<file>` from a file |
| `sofar commit-trailer` | Stamps a commit with the initiative that made it — the git hook calls this, you don't |
| `sofar adopt <file>` | Bring an older, hand written project log into sofar |
| `sofar uninit` | Undo `init` |

## How it works

One file per initiative holds the truth:
`.sofar/initiatives/<slug>/events.jsonl`. Every change is a single line added
to the end of it. Nothing is edited, nothing is deleted. The readable files
beside it are rebuilt from that log whenever it changes, so they cannot drift
out of step with what actually happened.

```
.sofar/
  repo.md                      notes true across all work (you write this one)
  bindings.json                which branch maps to which initiative
  initiatives/<slug>/
    events.jsonl               the log, and the only source of truth
    plan.md                    generated
    decisions.md               generated
    sessions/<id>.md           generated
```

A correction is a new line pointing at the old one. History is never rewritten.

What the assistant reads at the start of a session is a short summary, not the
whole history, so a long running project does not crowd out the actual work.
The full detail stays on disk for when it is needed. Decisions and the
approaches they ruled out are the one thing never cut.

## Optional extras

**Working unattended.** `sofar drive` takes the plan you already have and
works it: next task from the record, a fresh agent session for it, wait,
write down what changed, repeat. Sessions do not share a context window, so
the tenth task starts as clean as the first — the record is the handover,
which is the same thing it does for you between your own sessions.

```bash
sofar drive --allow 'Bash(npm test:*)' --session-timeout 900 --cost-cap 20
```

It stops when a task needs you and says which — that is a session marking
its task blocked with the question, not a guess about what it meant — and
otherwise when the work runs out, two sessions in a row get nowhere, or a
limit you set is reached. Everything it did is in the record afterwards:
which session took which task, why each one ended, what it cost.

You can also start it without leaving the agent you are talking to. Tell
Claude Code, Cursor or Codex "run this in sofar drive": the protocol block
has it write back first, then run `sofar drive --detach`, which starts the
run in the background and returns as soon as it has started, with the
run id, any warnings, and where to follow it. The run keeps going when
that session ends. `sofar drive --stop`, from any shell or session, ends
it.

**Watching it run.** A run has exactly one driver: a second `sofar drive`
on the same run is refused while the first is alive, and if the driver dies
(a crash, a `kill -9`), `sofar status` says *driver gone* rather than
*running*, and `--resume` picks the run up. `sofar drive --await` waits
without printing anything and exits with one line when the run stops,
quoting the question when a task needs you, or when its driver dies. It is
what an agent runs in its background shell after `--detach`, so it costs
nothing until there is something to act on. `sofar drive --follow`
prints a line per handoff and task change, for a terminal. In Claude Code,
your next prompt carries a `sofar drive:` line whenever the run has moved,
and the status line shows the task in flight, `gone` or why it stopped. On
a Mac, a run can keep the machine from idle-sleeping for as long as it
lasts: the first run in a terminal asks once, and `sofar drive
--keep-awake-setting on|off` changes the answer (closing the lid still
sleeps it).

Two things to know before you leave it running. It launches *your* agent
under *your* login, so what a session may do is your own configuration plus
the rules you pass — `--allow` widens, and sofar cannot narrow. And
`--cost-cap` and `--max-sessions` bound one run of the command; if you
resume an interrupted run, they start counting again, and it tells you so.

**Status line.** `sofar statusline --install` puts task progress, the
drive run's state, context fill and cache health in Claude Code's status bar, in one command and in
any repo — the line alone, no hooks and no `.sofar/`. Add `--user` to wire
it in `~/.claude/settings.json` for every project at once. (`sofar init
--statusline` wires the same thing as part of a full init.) It restores
what Claude Code's own status line shows, so nothing is lost by switching:
same model, directory and branch, in the same colors. An existing status
line is always left alone. The entry carries `refreshInterval: 10`, because
Claude Code re-runs a status line only on session start, a new message,
compact and mode toggles — without it an idle session shows a frozen line.
Retune that number freely; the line stays sofar's and `--uninstall` still
takes it off.

`sofar statusline --uninstall` takes it back off and Claude Code's own line
returns; `--user` removes the personal one. A status line that is not
sofar's is never removed, so this can only undo what sofar did.

**Staying current.** sofar tells you when a new release exists — a line
after `sofar status`, `init` or `doctor`, and an `↑0.18.0` on the status
bar — and leaves installing it to you, since an upgrade also wants a
`sofar init --refresh` in each repo to refresh its wiring. It never blocks: the
version lookup happens once a day in a background process, and every
command only reads the cached answer. If you would rather it just did the
upgrade, `sofar upgrade --auto on`. If you would rather it did nothing at
all, set `SOFAR_NO_UPDATE_CHECK=1` — and it never checks in CI or from a
non-global install. `sofar update-check` shows what it knows.

**Cloud sync.** Off unless you switch it on. `sofar login`, then
`sofar link --org <org>`, then `sofar push` and `sofar pull` to sync through
[api.sofar.sh](https://sofar.sh) instead of, or alongside, git. Work never
waits on the network: if the service is unreachable, unsent entries wait and go
out with the next push, with nothing lost or duplicated.

**Reading the record from your own code.** The package ships typed imports, so
a script or service can read a record without running the CLI:

```ts
import { validateEnvelope } from 'sofar.sh/schema'
import { foldLines } from 'sofar.sh/engine'
import { pushStream, pullStream } from 'sofar.sh/client'
```

**Tailwind v4.** Tailwind scans every file in a project for class names and can
produce broken CSS from the writing in the record. Add one line to your
`globals.css` (the path is relative to the stylesheet, not the repo root):

```css
@source not "../.sofar";
```

`sofar doctor --fix` will add it for you. That directive needs **Tailwind
4.1+** — before it, `not` parses as a path and breaks the build, so on 4.0.x
doctor reports the hazard and leaves your CSS alone. Either upgrade, or narrow
what Tailwind scans in the first place:

```css
@import "tailwindcss" source("./");
```

**Biome, Prettier, markdownlint.** Each formats or lints the whole tree by
default, and `.sofar/` is generated — so their checks go red on files nobody
hand-edits. `sofar doctor` names whichever you use, and `sofar doctor --fix`
writes each tool's own exclusion: `"!**/.sofar"` in `files.includes` for Biome
2 (`".sofar"` in `files.ignore` for Biome 1), `.sofar/` in `.prettierignore`
and `.markdownlintignore`, `"**/.sofar/**"` in a markdownlint-cli2 `ignores`.
A config with comments is left alone and the line to add is printed instead.
`sofar init` also writes `.mcp.json` and `.claude/settings.json` in the shape
your formatter would print (Biome's tabs, Prettier's widths, `.editorconfig`),
so a formatting pass never rewrites them.

The same goes for any tool that scans your whole tree: point it away from
`.sofar/`.

## Docs

* [docs/SPEC.md](docs/SPEC.md) is the full specification: events, tools, hooks,
  state, and what counts as done.
* [docs/FORMAT.md](docs/FORMAT.md) describes the file format on disk, for
  anyone writing a tool that reads or writes a record without this engine.

sofar tracks its own development with sofar, in the `.sofar/` folder of this
repo.

MIT licensed.
