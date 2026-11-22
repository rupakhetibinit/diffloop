---
name: diffloop-review
description: Read and write inline review comments on local diffs with diffloop. Use when a diffloop review window is open for the repository you are working in.
---

# diffloop review loop

diffloop is a localhost diff viewer pointed at a local git repo. Review comments
are anchored to file lines and shown inline in the diff. The agent talks to the
same review session through the `diffloop` CLI in that repository.

## Read the review

```sh
diffloop comments --json
```

Each item has `id`, `path`, `line`, `side`, `status`, `round`, and a `messages`
array with `author` (`you` or `agent`) and `body`. Address threads with status
`open`, `sent`, or `stale`. Do not touch `dismissed` threads.

Before editing, read the full conversation on a thread, not just its last
message. A resolved thread that the human reopened has a higher `round`.

## Write comments on the diff

Leave an inline note on a specific line:

```sh
diffloop comment add --path src/foo.ts --line 42 --body "Handle the empty case here."
```

Use `--side deletions` when the note is about a removed line. Keep notes short,
specific, and anchored to the line that needs attention. One note per issue.

Add a note to an existing thread without changing its state:

```sh
diffloop comment note <thread-id> --body "Also check the caller in foo.ts."
```

## Close out a thread

When you have actually addressed a thread's request in the working tree:

```sh
diffloop resolve <thread-id> --reply "Clamped the value and added a test."
```

This posts your reply into the same inline thread and marks it `resolved`. The
human may reopen it with another reply; treat that as a new round of work.

Do not resolve a thread you did not fix. If you disagree with a comment, reply
with a note explaining why and leave its status alone.

## Multiple windows

If several repos are open at once, diffloop picks the server by your current
working directory's git root. Run `diffloop sessions` to see open repos and their
base refs. From outside a repo, pass `--repo <path>` to any command.

## Rules

- Run these commands from a shell whose working directory is the reviewed repo.
- The window must be running; commands fail with `no diffloop server for <repo>` otherwise.
- Never edit diffloop's state files under `~/.local/share/diffloop` directly.
- Do not mark a thread resolved just to clear the list.
