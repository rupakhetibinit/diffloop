# Rust binary

Everything that ships is Rust. The server, CLI, and native tree-sitter grammars
are compiled into one binary; the checked-in fixtures in `tests/fixtures.json`
keep CLI and API output stable.

## Build

The frontend build embeds the web app into `rust/assets/` before Cargo runs:

```sh
bun install
bun run bundle:web
cd rust && cargo build --release
```

## Test

```sh
bun run test:compat
```

The suite creates a temporary repo with TypeScript, C#, Go and Python changes,
starts the Rust binary, and compares patches, branch switching, thread
lifecycle, CLI output, SSE, multi-repo routing, grammars, upgrade check, and
errors against the frozen fixtures.

## Notes

- Release binary: about 25 MB (stripped, `opt-level = "z"`, LTO).
- Native tree-sitter grammars are compiled in for TS/TSX/JS, Rust, C#, Python,
  and Go. `grammars` reports the same registry shape as the legacy CLI.
- Cross-compilation targets and release artifacts are configured in
  `.github/workflows/ci.yml`.
