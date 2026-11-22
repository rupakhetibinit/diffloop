# diffloop

A local, single-binary diff review window for agent-written changes. It serves a
DiffsHub-style split/unified diff over localhost, with line comments that round-trip
through a Claude Code session.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rupakhetibinit/diffloop/main/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rupakhetibinit/diffloop/main/install.ps1 | iex
```

Upgrade in place with `diffloop upgrade` (or check first with
`diffloop upgrade --check`). It downloads the latest release binary and replaces
the running one; on Windows, close any diffloop windows and it will finish the
swap in the background. The `upgrade` command is available from v0.1.2 onward —
run the installer once if you have an older binary.

## Run

```sh
diffloop --repo /path/to/repo          # opens the browser
diffloop --repo /path/to/repo --no-open --port 4317
```

Build from source with `bun install && bun run build.ts`. The compiled `diffloop`
contains the web UI and the web-language grammars; no Node runtime is needed.

## Review loop

1. Click a line number or hover a line and press `+` to start a comment. The
   composer opens inline on that line.
2. **Send to agent** marks the threads as ready for the agent.
3. In Claude Code, ask it to read the review and act on it:

   ```sh
   diffloop comments --json
   diffloop resolve <id> --reply "fixed in working tree"
   diffloop comment add --path src/foo.ts --line 42 --body "Handle the empty case."
   diffloop comment note <id> --body "Also check the caller."
   ```

   Threads, replies and state render inline under their line. `resolve` posts the
   agent's reply into the same thread and marks it resolved. If you disagree,
   press **Reopen**, reply, and the round number increments. `SKILL.md` is the
   agent-facing version of this workflow.

The diff view reloads automatically as the working tree changes. Comments re-anchor
by line content, and become `stale` if their line can't be found.

## Multiple repositories

Every open window registers its repo, port, and token in
`~/.config/diffloop/daemons.json`. CLI commands find the right server from your
current working directory (the git root), so you can have three repos open side
by side and just run `diffloop comments` from each one. Pass `--repo <path>` to
override, and run `diffloop sessions` to list open reviews and their base refs.

## Compare against a branch

The base ref field in the toolbar defaults to `HEAD`, but you can type any git
ref — `develop`, `origin/develop`, a tag, or a commit — and press `↳`. The branch
list is available as suggestions. Committed changes on the current branch are
included in the diff, which is useful for reviewing a batch of commits before
opening a PR. Start with `diffloop --repo <path> --base origin/develop` to pick a
base at launch.

## Function and block context

Context is injected as normal unchanged diff lines, in tiers:

- the enclosing function signature (1 line),
- the innermost enclosing block header and up to 4 lines — `for`, `if`, `try`,
  `switch`, and equivalents — with paired `else`, `catch` and `finally` lines
  when present,
- the change itself, with the normal collapsed "N unmodified lines" bar between.

Tree-sitter provides the scopes; no Go-specific parser is involved.

## Language grammars

Embedded in the binary: JavaScript, TypeScript, TSX, HTML, CSS, JSON, XML, SQL,
YAML, Markdown, Vue, Perl.

Other grammars are downloaded on first use to `~/.cache/diffloop/grammars`:
C#, Go, Rust, Python, Java, C, C++, Ruby, PHP, Scala, Dart, Elixir, Haskell,
OCaml, Solidity, Svelte, Bash, TOML.

List them with `./diffloop grammars`. Add or override a grammar by writing
`~/.config/diffloop/grammars.json`:

```json
[
  {
    "file": "tree-sitter-my.lang.wasm",
    "extensions": [".my"],
    "url": "https://example.com/tree-sitter-my.lang.wasm"
  }
]
```

`localPath` can be used instead of `url` for a wasm file already on disk.
