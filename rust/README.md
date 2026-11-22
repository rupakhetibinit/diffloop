# Rust server

The Rust server is now the only server. The previous Bun implementation was
used to generate the frozen compatibility fixtures in `tests/fixtures.json`
and has been removed.

## Build

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
errors against the frozen Bun outputs. It currently passes 7 tests / 27
assertions.

## Notes

- Release binary: about 25 MB (stripped, `opt-level = "z"`, LTO).
- Native tree-sitter grammars are compiled in for TS/TSX/JS, Rust, C#, Python,
  and Go. `grammars` reports the same registry shape as the old Bun binary.
- Cross-compilation targets and release artifacts are configured in
  `.github/workflows/ci.yml`.
