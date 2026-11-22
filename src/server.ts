import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { augmentPatch, buildPatch, patchHash, reanchor } from "./git";
import { changedPaths, functionContexts, type FunctionContext } from "./functions";
import { actionableThreads, addThread, loadState, mutateThread, resolveThread, saveState } from "./store";
import type { RepoState, ServerInfo, Side } from "./types";
import { CSS, HTML, JS } from "./embedded";

type Client = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();
const daemonFile = () => join(homedir(), ".config", "diffloop", "daemon.json");

export async function startServer(repo: string, token: string, open: boolean, requestedPort = 0) {
  const root = resolve(repo);
  const clients = new Set<Client>();
  let patch = await buildPatch(root);
  let hash = patchHash(patch);
  let functions: FunctionContext[] = [];
  let displayPatch = patch;
  const updateFunctions = async () => {
    functions = await functionContexts(root, patch, changedPaths(patch));
    displayPatch = await augmentPatch(root, patch, functions);
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
    const next = await buildPatch(root);
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
        const match = path.match(/^\/ctl\/threads\/([a-z0-9]+)\/resolve$/);
        if (match && method === "POST") {
          const body = (await req.json()) as { reply?: string };
          try {
            const thread = await resolveThread(root, match[1], body.reply ?? "");
            broadcast({ type: "threads" });
            return Response.json(thread);
          } catch (error) {
            return new Response(String(error), { status: 404 });
          }
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

  const info: ServerInfo = { port: server.port, token, repo: root };
  await mkdir(join(daemonFile(), ".."), { recursive: true });
  await writeFile(daemonFile(), JSON.stringify(info));
  const stop = async () => {
    await unlink(daemonFile()).catch(() => {});
    server.stop();
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

  setInterval(() => void refresh(), 1200);

  const url = `http://127.0.0.1:${server.port}`;
  console.log(`diffloop serving ${root}\n${url}`);
  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  }
  return { url, stop };
}

export async function readDaemon(): Promise<ServerInfo | null> {
  try {
    return JSON.parse(await readFile(daemonFile(), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}
