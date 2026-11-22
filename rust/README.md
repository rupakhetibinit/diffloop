# Rust exploration branch

This branch tests replacing the Bun server with Rust while reusing the exact
same web UI and HTTP contract.

## Build and run

```sh
bun run bundle-web.ts          # bundles web/main.ts into rust/assets/app.js
cd rust
cargo build --release
./target/release/diffloop-rs serve --repo /path/to/repo --port 4317
```

## What works

- Embedded HTML/CSS/JS, same split/unified diff UI, file tree, inline threads,
  branch base selector, and 1.5s polling instead of SSE.
- Git patch generation (working tree plus untracked files), branch refs,
  patch-based thread anchoring, and the `threads.json` state format shared with
  the Bun server.
- Native tree-sitter scope detection for TypeScript, TSX, Rust, C#, Python and
  Go, including function signatures, block headers, and `else`/`catch`/`finally`
  companion lines.
- Function and block context hunks injected into the patch as normal unchanged
  lines, matching the Bun server's tiers.

## Size

Release binary: **24 MB** (stripped, `opt-level = "z"`, LTO), versus **123 MB**
for the Bun single-file executable. The Rust binary still embeds an 11 MB
minified `app.js`; without the UI it would be roughly 13 MB.

## Not done in this branch

- SSE live updates (polling is used instead).
- Multi-repo CLI routing, daemon registry, `upgrade`, and install scripts.
- Windows/macOS cross-compilation matrix and release workflow.
- Full grammar configurability with runtime downloads; grammars are compiled in.
- Full CLI parity (`resolve`, `comment add`, `comment note`, `grammars`).

This is an exploration of the size/effort tradeoff, not a drop-in replacement.
