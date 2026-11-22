import { randomUUID } from "node:crypto";
import { readDaemon, startServer } from "./server";
import { grammarStatus } from "./grammars";
import type { Thread } from "./types";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "serve";

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

async function control(path: string, init?: RequestInit): Promise<Response> {
  const daemon = await readDaemon();
  if (!daemon) throw new Error("no diffloop server running for this user");
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
    await startServer(repo, randomUUID().replaceAll("-", ""), !has("no-open"), port);
    break;
  }
  default:
    throw new Error(`unknown command ${command}`);
}
