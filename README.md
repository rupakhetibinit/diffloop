# diffloop

A local, single-binary diff review window for agent-written changes. It serves a
DiffsHub-style split/unified diff over localhost, with inline comments that
round-trip through a Claude Code session. The server is Rust; the diff renderer
is a small embedded web app.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rupakhetibinit/diffloop/main/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rupakhetibinit/diffloop/main/install.ps1 | iex
```

Upgrade in place with `diffloop upgrade` (or check first with
`diffloop upgrade --check`).

## Run

```sh
diffloop --repo /path/to/repo          # opens the browser
diffloop --repo /path/to/repo --no-open --port 4317
diffloop --repo /path/to/repo --base origin/develop
```

Click a line number or hover a line and press `+` to leave a comment. Threads,
replies, and their state render inline under the line. **Send to agent** marks
threads ready; the agent uses the CLI to reply and resolve them.

## Agent workflow

```sh
diffloop comments --json
diffloop comment add --path src/foo.ts --line 42 --body "Handle the empty case."
diffloop comment note <id> --body "Also check the caller."
diffloop resolve <id> --reply "fixed in working tree"
```

`SKILL.md` is the agent-facing version of this workflow. Commands target the
open window for the current git root. With several repos open, run
`diffloop sessions` or pass `--repo <path>`.

## Diff context

Context is injected as normal unchanged diff lines, in tiers:

- enclosing function signature (1 line),
- innermost enclosing block header and up to 4 lines — `for`, `if`, `try`,
  `switch`, and equivalents — with paired `else`/`catch`/`finally` lines,
- the change itself, with collapsed "N unmodified lines" bars between.

Tree-sitter parsing is native for TypeScript, TSX, JavaScript, Rust, C#,
Python, and Go. `diffloop grammars` lists the grammar registry.

## Development

```sh
bun install
bun run bundle:web                    # rebuild embedded frontend assets
cd rust && cargo build --release
cd .. && bun run test:compat          # frozen compatibility suite
```

The release binary is about 25 MB, versus 123 MB for the previous Bun build.
CI builds all five platform targets, runs the compatibility suite, and attaches
binaries to GitHub releases under the names the install scripts expect.
