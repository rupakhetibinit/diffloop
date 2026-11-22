# diffloop

A local, single-binary diff review window for agent-written changes. It serves a
DiffsHub-style split/unified diff over localhost, with line comments that round-trip
through a Claude Code session.

## Run

```sh
./diffloop --repo /path/to/repo          # opens the browser
./diffloop --repo /path/to/repo --no-open --port 4317
```

Build from source with `bun install && bun run build.ts`. The compiled `diffloop`
contains the web UI and the web-language grammars; no Node runtime is needed.

## Review loop

1. Click a line number in the diff to start a comment.
2. **Send to agent** marks the threads as ready for the agent.
3. In Claude Code, ask it to read the review and act on it:

   ```sh
   ./diffloop comments --json     # threads with file, line, and conversation
   ./diffloop resolve <id> --reply "fixed in working tree"
   ```

   `resolve` marks the thread resolved and posts the agent's reply into the same
   thread. If you disagree, press **Reopen**, reply, and the round number increments.

The diff view reloads automatically as the working tree changes. Comments re-anchor
by line content, and become `stale` if their line can't be found.

## Function context

For a changed function, the first up-to-8 lines of its declaration are injected as
normal unchanged diff lines above the change. The middle of a long function stays
collapsed behind the usual "N unmodified lines" bar. This uses tree-sitter, not a
Go-specific parser.

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
