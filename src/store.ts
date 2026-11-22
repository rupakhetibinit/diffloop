import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message, RepoState, Side, Thread } from "./types";

const stateRoot = () => join(homedir(), ".local", "share", "diffloop");

function repoKey(repo: string): string {
  return createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
}

function statePath(repo: string): string {
  return join(stateRoot(), repoKey(repo), "threads.json");
}

export async function loadState(repo: string): Promise<RepoState> {
  try {
    const raw = await readFile(statePath(repo), "utf8");
    const parsed = JSON.parse(raw) as RepoState;
    return { repo: resolve(repo), threads: Array.isArray(parsed.threads) ? parsed.threads : [] };
  } catch {
    return { repo: resolve(repo), threads: [] };
  }
}

export async function saveState(state: RepoState): Promise<void> {
  const target = statePath(state.repo);
  await mkdir(join(target, ".."), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await Bun.write(target, await readFile(tmp));
  await Bun.file(tmp).delete();
}

function message(author: Message["author"], body: string): Message {
  return { id: randomUUID().slice(0, 8), author, body, at: new Date().toISOString() };
}

export async function addThread(
  repo: string,
  input: { path: string; side: Side; line: number; anchor: string; body: string },
): Promise<Thread> {
  const state = await loadState(repo);
  const now = new Date().toISOString();
  const thread: Thread = {
    id: randomUUID().slice(0, 8),
    path: input.path,
    side: input.side,
    line: input.line,
    anchor: input.anchor,
    messages: [message("you", input.body)],
    status: "open",
    round: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.threads.push(thread);
  await saveState(state);
  return thread;
}

type Mutation =
  | { kind: "send" }
  | { kind: "dismiss" }
  | { kind: "reply"; author: Message["author"]; body: string; status?: Thread["status"] };

export async function mutateThread(repo: string, id: string, mutation: Mutation): Promise<Thread> {
  const state = await loadState(repo);
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) throw new Error(`unknown thread ${id}`);

  if (mutation.kind === "reply") {
    thread.messages.push(message(mutation.author, mutation.body));
    if (mutation.status) thread.status = mutation.status;
    else if (thread.status === "resolved" || thread.status === "dismissed") {
      thread.status = "open";
      thread.round += 1;
    }
  } else if (mutation.kind === "send") {
    if (thread.status === "open" || thread.status === "stale") thread.status = "sent";
  } else {
    thread.status = thread.status === "dismissed" ? "open" : "dismissed";
  }

  thread.updatedAt = new Date().toISOString();
  await saveState(state);
  return thread;
}

export async function resolveThread(repo: string, id: string, reply: string): Promise<Thread> {
  return mutateThread(repo, id, { kind: "reply", author: "agent", body: reply, status: "resolved" });
}

export async function actionableThreads(repo: string): Promise<Thread[]> {
  const state = await loadState(repo);
  return state.threads.filter((t) => t.status === "open" || t.status === "sent" || t.status === "stale");
}
