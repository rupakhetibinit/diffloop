# Rust rewrite

This branch replaces the Bun server with Rust while keeping the same web UI,
HTTP contract, state files, and CLI behavior.

## Build, run, test

```sh
bun run bundle-web.ts          # bundles web/main.ts into rust/assets/app.js
cd rust && cargo build --release
cd ..
bun test tests/compat.test.ts  # runs the Bun and Rust binaries side by side
```

`tests/compat.test.ts` is the compatibility gate. It creates a temporary repo
with TypeScript, C#, Go and Python changes, starts both binaries with isolated
HOME directories, and compares patches, stats, branch switching, thread state,
CLI output, SSE, multi-repo routing, `grammars`, `upgrade --check`, and error
handling. It currently passes 14 tests / 50 assertions.

## Implemented

- Same embedded UI and split/unified diff rendering.
- Git working-tree diffs, untracked files, branch base refs, and branch list.
- Function/block context tiers via native tree-sitter: TS/TSX/JS, Rust, C#,
  Python, Go, with `else`/`catch`/`finally` companion lines.
- Inline thread lifecycle: open → sent → resolved → reopened, dismiss, note,
  reply, re-anchoring, and the shared `threads.json` format.
- Multi-repo daemon registry, CLI routing from cwd or `--repo`, and `sessions`.
- SSE live updates, `/api/*` and `/ctl/*` endpoints with token auth.
- `--version`, `--help`, `--base`, `--port`, `--no-open`, `upgrade --check`,
  and Windows-safe browser launching.

## Differences to be aware of

- Grammars are compiled into the binary; the runtime WASM download system is
  replaced by a cache marker so `grammars` output matches the Bun binary.
- `upgrade` fetches the same GitHub releases and self-replaces on Unix; the
  Windows background swap follows the same pattern as the Bun CLI.
- Release workflow and installers have not yet been switched to the Rust binary.

## Size

Release binary: **25 MB** (stripped, `opt-level = "z"`, LTO), versus **123 MB**
for the Bun single-file executable. About 11 MB of the Rust binary is the
embedded minified frontend.
