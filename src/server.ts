import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { augmentPatch, buildPatch, listBranches, patchHash, reanchor, refExists, workingLines } from "./git";
import { changedPaths, functionContexts, type FunctionContext } from "./functions";
import { actionableThreads, addThread, loadState, mutateThread, noteThread, resolveThread, saveState } from "./store";
import type { RepoState, ServerInfo, Side } from "./types";
import { CSS, HTML, JS } from "./embedded";

type Client = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();
const registryFile = () => join(homedir(), ".config", "diffloop", "daemons.json");

async function readRegistry(): Promise<Record<string, ServerInfo>> {
  try {
    return JSON.parse(await readFile(registryFile(), "utf8")) as Record<string, ServerInfo>;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: Record<string, ServerInfo>): Promise<void> {
  await mkdir(join(registryFile(), ".."), { recursive: true });
  await writeFile(registryFile(), JSON.stringify(registry, null, 2));
}

export async function findDaemon(repo: string): Promise<ServerInfo | null> {
  const registry = await readRegistry();
  return registry[resolve(repo)] ?? null;
}

export async function listDaemons(): Promise<ServerInfo[]> {
  return Object.values(await readRegistry());
}

export async function startServer(
  repo: string,
  token: string,
  open: boolean,
  requestedPort = 0,
  initialBase = "HEAD",
) {
  const root = resolve(repo);
  const clients = new Set<Client>();
  let currentBase = initialBase;
  let patch = await buildPatch(root, currentBase);
  let hash = patchHash(patch);
  let functions: FunctionContext[] = [];
  let displayPatch = patch;
  const updateFunctions = async () => {
    functions = await functionContexts(root, patch, changedPaths(patch));
    displayPatch = await augmentPatch(root, patch, functions, currentBase);
  };
  await updateFunctions();

  const broadcast = (event: unknown) => {
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  const refresh = async () => {
    const next = await buildPatch(root, currentBase);
    const nextHash = patchHash(next);
    if (nextHash !== hash) {
      patch = next;
      hash = nextHash;
      await updateFunctions();
      broadcast({ type: "diff" });
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: requestedPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === "GET" && path === "/") {
        const html = HTML || (await Bun.file("web/index.html").text());
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && path === "/app.js") {
        const js = JS || (await Bun.file("web/main.ts").text());
        return new Response(js, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      }
      if (method === "GET" && path === "/app.css") {
        const css = CSS || (await Bun.file("web/style.css").text());
        return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      }

      if (path === "/api/branches" && method === "GET") {
        return Response.json({ branches: await listBranches(root) });
      }

      if (path === "/api/base" && method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && origin !== `http://127.0.0.1:${server.port}`) {
          return new Response("forbidden origin", { status: 403 });
        }
        const body = (await req.json()) as { base?: string };
        const nextBase = body.base?.trim();
        if (!nextBase) return new Response("missing base", { status: 400 });
        if (!(await refExists(root, nextBase))) {
          return Response.json({ error: `unknown ref ${nextBase}` }, { status: 400 });
        }
        currentBase = nextBase;
        patch = await buildPatch(root, currentBase);
        hash = patchHash(patch);
        await updateFunctions();
        const registry = await readRegistry();
        if (registry[root]) {
          registry[root].base = currentBase;
          await writeRegistry(registry);
        }
        broadcast({ type: "diff" });
        return Response.json({ base: currentBase });
      }

      if (path === "/api/events" && method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            clients.add(controller);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));
          },
          cancel(controller) {
            clients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (path === "/api/state" && method === "GET") {
        await refresh();
        const state = await loadState(root);
        let changed = false;
        for (const thread of state.threads) {
          if (thread.status === "dismissed" || !thread.anchor) continue;
          const line = await reanchor(root, thread);
          if (line === null && thread.status !== "stale") {
            thread.status = "stale";
            changed = true;
          } else if (line !== null && line !== thread.line) {
            thread.line = line;
            if (thread.status === "stale") thread.status = "open";
            changed = true;
          }
        }
        if (changed) await saveState(state);
        let additions = 0;
        let deletions = 0;
        for (const line of patch.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          if (line.startsWith("-") && !line.startsWith("---")) deletions++;
        }
        return Response.json({
          repo: root,
          base: currentBase,
          patch: displayPatch,
          threads: state.threads,
          functions,
          stats: { files: changedPaths(patch).length, additions, deletions },
        });
      }

      const origin = req.headers.get("origin");
      if (path.startsWith("/api/") && method === "POST") {
        if (origin && origin !== `http://127.0.0.1:${server.port}`) {
          return new Response("forbidden origin", { status: 403 });
        }
      }

      if (path === "/api/threads" && method === "POST") {
        const body = (await req.json()) as { path?: string; side?: Side; line?: number; anchor?: string; body?: string };
        if (!body.path || !body.side || !body.line || !body.body) {
          return new Response("missing fields", { status: 400 });
        }
        const thread = await addThread(root, {
          path: body.path,
          side: body.side,
          line: body.line,
          anchor: body.anchor ?? "",
          body: body.body,
        });
        broadcast({ type: "threads" });
        return Response.json(thread, { status: 201 });
      }

      const threadMatch = path.match(/^\/api\/threads\/([a-z0-9]+)\/(reply|send|dismiss)$/);
      if (threadMatch && method === "POST") {
        const [, id, action] = threadMatch;
        const body = (await req.json().catch(() => ({}))) as { body?: string };
        try {
          if (action === "reply" && !body.body) return new Response("missing body", { status: 400 });
          const thread = await mutateThread(
            root,
            id,
            action === "reply"
              ? { kind: "reply", author: "you", body: body.body! }
              : action === "send"
                ? { kind: "send" }
                : { kind: "dismiss" },
          );
          broadcast({ type: "threads" });
          return Response.json(thread);
        } catch (error) {
          return new Response(String(error), { status: 404 });
        }
      }

      if (path.startsWith("/ctl/")) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
        const match = path.match(/^\/ctl\/threads\/([a-z0-9]+)\/(resolve|note)$/);
        if (match && method === "POST") {
          const body = (await req.json()) as { reply?: string; body?: string };
          try {
            const thread = match[2] === "resolve"
              ? await resolveThread(root, match[1], body.reply ?? "")
              : await noteThread(root, match[1], body.body ?? "");
            broadcast({ type: "threads" });
            return Response.json(thread);
          } catch (error) {
            return new Response(String(error), { status: 404 });
          }
        }
        if (path === "/ctl/threads" && method === "POST") {
          const body = (await req.json()) as { path?: string; side?: Side; line?: number; body?: string };
          if (!body.path || !body.line || !body.body) return new Response("missing fields", { status: 400 });
          const lines = await workingLines(root, body.path);
          const thread = await addThread(root, {
            path: body.path,
            side: body.side ?? "additions",
            line: body.line,
            anchor: lines[body.line - 1] ?? "",
            body: body.body,
            author: "agent",
          });
          broadcast({ type: "threads" });
          return Response.json(thread, { status: 201 });
        }
        if (path === "/ctl/threads" && method === "GET") {
          return Response.json(await actionableThreads(root));
        }
        if (path === "/ctl/status" && method === "GET") {
          const state: RepoState = await loadState(root);
          return Response.json({ repo: root, threads: state.threads.length });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  const info: ServerInfo = { port: server.port, token, repo: root, base: currentBase };
  const registry = await readRegistry();
  registry[root] = info;
  await writeRegistry(registry);
  const stop = async () => {
    const current = await readRegistry();
    if (current[root]?.port === server.port) {
      delete current[root];
      await writeRegistry(current);
    }
    server.stop();
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

  setInterval(() => void refresh(), 1200);

  const url = `http://127.0.0.1:${server.port}`;
  console.log(`diffloop serving ${root}\n${url}`);
  if (open) {
    const attempts = process.platform === "win32"
      ? [["cmd", "/c", "start", "", url], ["explorer", url]]
      : process.platform === "darwin"
        ? [["open", url]]
        : [["xdg-open", url]];
    let opened = false;
    for (const command of attempts) {
      try {
        Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
        opened = true;
        break;
      } catch {
        // Try the next opener, then leave the URL to the user.
      }
    }
    if (!opened) console.log(`Could not open a browser automatically. Open ${url}`);
  }
  return { url, stop };
}
