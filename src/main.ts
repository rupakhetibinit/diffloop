import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { findDaemon, listDaemons, startServer } from "./server";
import { grammarStatus } from "./grammars";
import { installUpgrade, latestRelease, newerVersion } from "./upgrade";
import type { Thread } from "./types";

const args = process.argv.slice(2);
const VERSION = "0.1.2";

if (args.includes("--version") || args.includes("-v")) {
  console.log(`diffloop ${VERSION}`);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`diffloop ${VERSION}

Usage:
  diffloop --repo <path> [--base <ref>] [--port <n>] [--no-open]
  diffloop comments [--json] [--repo <path>]
  diffloop comment add --path <file> --line <n> --body "note"
  diffloop comment note <id> --body "note"
  diffloop resolve <id> --reply "done"
  diffloop sessions
  diffloop grammars
  diffloop upgrade [--check]`);
  process.exit(0);
}

const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "serve";

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

if (has("repo") && !flag("repo")) throw new Error("--repo needs a path");

async function targetRepo(): Promise<string> {
  const explicit = flag("repo");
  if (explicit) return resolve(explicit);
  const proc = Bun.spawn(["git", "-C", process.cwd(), "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out || process.cwd();
}

async function control(path: string, init?: RequestInit): Promise<Response> {
  const repo = await targetRepo();
  const daemon = await findDaemon(repo);
  if (!daemon) {
    const open = await listDaemons();
    const hint = open.length
      ? `Open reviews:\n${open.map((item) => `  ${item.repo} (port ${item.port})`).join("\n")}\nPass --repo <path> or cd into the repo.`
      : "Start one with diffloop --repo <path>.";
    throw new Error(`no diffloop server for ${repo}\n${hint}`);
  }
  return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

function printThreads(threads: Thread[]) {
  if (threads.length === 0) {
    console.log("No open review threads.");
    return;
  }
  for (const thread of threads) {
    const last = thread.messages.at(-1);
    console.log(`${thread.id}  ${thread.path}:${thread.line}  [${thread.status}] round ${thread.round}`);
    console.log(`    ${last?.body.replace(/\n/g, "\n    ")}`);
  }
  console.log(`\n${threads.length} open thread(s). Reply with: diffloop resolve <id> --reply "done"`);
}

switch (command) {
  case "comments": {
    const response = await control("/ctl/threads");
    const threads = (await response.json()) as Thread[];
    if (has("json")) console.log(JSON.stringify(threads, null, 2));
    else printThreads(threads);
    break;
  }
  case "comment": {
    const action = args.shift();
    if (action === "add") {
      const path = flag("path");
      const line = Number(flag("line"));
      const body = flag("body");
      if (!path || !line || !body) {
        throw new Error('usage: diffloop comment add --path <file> --line <n> --body "note"');
      }
      const response = await control("/ctl/threads", {
        method: "POST",
        body: JSON.stringify({ path, line, body, side: flag("side") ?? "additions" }),
      });
      if (!response.ok) throw new Error(await response.text());
      const thread = (await response.json()) as Thread;
      console.log(`added ${thread.id} (${thread.path}:${thread.line})`);
    } else if (action === "note") {
      const id = args.shift();
      const body = flag("body");
      if (!id || !body) throw new Error('usage: diffloop comment note <id> --body "note"');
      const response = await control(`/ctl/threads/${id}/note`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      if (!response.ok) throw new Error(await response.text());
      console.log(`noted ${id}`);
    } else {
      throw new Error("usage: diffloop comment add|note ...");
    }
    break;
  }
  case "resolve": {
    const id = args[0];
    if (!id) throw new Error("usage: diffloop resolve <thread-id> --reply \"...\"");
    const reply = flag("reply") ?? "";
    const response = await control(`/ctl/threads/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
    if (!response.ok) throw new Error(await response.text());
    const thread = (await response.json()) as Thread;
    console.log(`resolved ${thread.id} (${thread.path}:${thread.line})`);
    break;
  }
  case "upgrade": {
    const release = await latestRelease();
    if (!newerVersion(VERSION, release.version)) {
      console.log(`diffloop ${VERSION} is up to date (latest ${release.tag}).`);
      break;
    }
    if (has("check")) {
      console.log(`diffloop ${release.tag} is available (installed ${VERSION}).`);
      break;
    }
    console.log(`Upgrading diffloop ${VERSION} -> ${release.tag} (${release.asset.name})...`);
    await installUpgrade(release);
    if (process.platform === "win32") {
      console.log("Windows: close diffloop windows; the new binary replaces itself in a moment.");
    } else {
      console.log(`Upgraded to ${release.tag}. Restart any running diffloop windows.`);
    }
    break;
  }
  case "sessions": {
    const sessions = await listDaemons();
    if (sessions.length === 0) console.log("No diffloop sessions running.");
    else for (const session of sessions) console.log(`${session.repo}\t${session.port}\tbase=${session.base ?? "HEAD"}`);
    break;
  }
  case "status": {
    const response = await control("/ctl/status");
    console.log(await response.text());
    break;
  }
  case "grammars": {
    console.table(await grammarStatus());
    break;
  }
  case "serve": {
    const repo = flag("repo") ?? ".";
    const port = Number(flag("port") ?? 0);
    const base = flag("base") ?? "HEAD";
    await startServer(repo, randomUUID().replaceAll("-", ""), !has("no-open"), port, base);
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}
