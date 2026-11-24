import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "rust/target/release/diffloop-rs");
const FIXTURES = JSON.parse(readFileSync(join(ROOT, "tests/fixtures.json"), "utf8"));
const TMP = join(ROOT, ".amp/in/compat");
const REPO = join(TMP, "repo");
const REPO2 = join(TMP, "repo2");
const HOME = join(TMP, "home");
const HOMEBASE = join(TMP, "home-base");
const PORTS = { main: 0, second: 0, base: 0 };
const servers: ReturnType<typeof Bun.spawn>[] = [];


function killStale() {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (cmd.startsWith(BIN) && cmd.includes("/in/compat/")) process.kill(Number(entry), "SIGTERM");
    } catch {}
  }
}
function sh(command: string, cwd: string) {
  const result = spawnSync(command, { shell: "/bin/bash", cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}\n${result.stderr}`);
}
function run(args: string[], cwd: string) {
  const result = spawnSync(BIN, args, { cwd, encoding: "utf8", env: { ...process.env, HOME } });
  return { out: result.stdout ?? "", err: result.stderr ?? "", code: result.status ?? 1 };
}
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function start(repo: string, port: number, base?: string, home = HOME) {
  const args = [BIN, "--repo", repo, "--port", String(port), "--no-open"];
  if (base) args.push("--base", base);
  const proc = Bun.spawn(args, { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
  servers.push(proc);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start on ${port}`);
}
async function state(port: number) {
  return (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
}
async function post(port: number, path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function diffAfter(port: number, action: () => void): Promise<boolean> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const read = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          if (JSON.parse(line.slice(6)).type === "diff") return true;
        }
      }
    } catch {
      return false;
    }
  })();
  action();
  const found = await Promise.race([
    read,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  controller.abort();
  return found;
}
function norm(value: any): any {
  if (typeof value === "string") {
    return value
      .split(ROOT.replace(/\/$/, "")).join("<ROOT>")
      .replace(/\b[0-9a-f]{8,16}\b/g, "<id>")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
      .replace(/\d{13,}/g, "<time>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .replace(/\t\d+\t/g, "\t<port>\t")
      .replace(/latest v[\d.]+/g, "latest v<version>")
      .replace(/installed [\d.]+/g, "installed <version>")
      .replace(/\/freeze\//g, "/compat/")
      .replace(/\/[^"\s]*\/diffloop\/\.amp\/in\/compat/g, "<ROOT>/.amp/in/compat");
  }
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, norm(item)]));
  }
  return value;
}

beforeAll(async () => {
  killStale();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(HOMEBASE, { recursive: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(join(REPO, "src/app.ts"), "export function total(values: number[]) {\n  let sum = 0;\n  for (const value of values) {\n    sum += value;\n  }\n  return sum;\n}\n");
  const flow = [
    "export function flow(values: number[]) {", "  let total = 0;", "  for (const value of values) {",
    "    if (value > 10) {", "      total += value;", "    } else {", "      total += 1;", "    }", "  }",
    "  try {", "    total += 100;", "  } catch (error) {", "    total -= 1;", "  } finally {", "    total += 2;", "  }",
    ...Array.from({ length: 180 }, (_, i) => `  // padding ${i}`), "  return total;", "}",
  ].join("\n") + "\n";
  writeFileSync(join(REPO, "src/flow.ts"), flow);
  writeFileSync(join(REPO, "src/sample.cs"), "class Calc {\n  public int Total(int[] values) {\n    int sum = 0;\n    foreach (var v in values) {\n      sum += v;\n    }\n    return sum;\n  }\n}\n");
  writeFileSync(join(REPO, "src/sample.go"), "package main\n\nfunc Sum(values []int) int {\n\ttotal := 0\n\tfor _, value := range values {\n\t\ttotal += value\n\t}\n\treturn total\n}\n");
  writeFileSync(join(REPO, "src/sample.py"), "def total(values):\n    result = 0\n    for value in values:\n        if value > 0:\n            result += value\n        else:\n            result -= 1\n    return result\n");
  sh("git init -q && git config user.email t@t && git config user.name T && git add . && git commit -qm init", REPO);
  sh("git branch develop && git checkout -b feature", REPO);
  writeFileSync(join(REPO, "src/app.ts"), "export function total(values: number[]) {\n  let sum = 0;\n  for (const value of values) {\n    sum += Math.max(value, 0);\n  }\n  return sum;\n}\n");
  writeFileSync(join(REPO, "src/new.ts"), "export const ready = true;\n");
  sh("git add . && git commit -qm feature", REPO);
  const edit = (name: string, from: string, to: string) => {
    const path = join(REPO, name);
    writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
  };
  edit("src/flow.ts", "total += value;", "total += Math.max(value, 0);");
  edit("src/sample.cs", "sum += v;", "sum += Math.Max(v, 0);");
  edit("src/sample.go", "total += value", "total += max(value, 0)");
  edit("src/sample.py", "result += value", "result += max(value, 0)");
  mkdirSync(join(REPO2, "src"), { recursive: true });
  writeFileSync(join(REPO2, "src/other.ts"), "export const other = 1;\n");
  sh("git init -q && git config user.email t@t && git config user.name T && git add . && git commit -qm init", REPO2);
  writeFileSync(join(REPO2, "src/other.ts"), "export const other = 2;\n");

  PORTS.main = await freePort();
  PORTS.second = await freePort();
  PORTS.base = await freePort();
  await start(REPO, PORTS.main);
  await start(REPO2, PORTS.second);
  await start(REPO, PORTS.base, "develop", HOMEBASE);
});

afterAll(() => {
  for (const proc of servers) proc.kill();
});

test("version and help match the frozen fixtures", () => {
  expect(norm(run(["--version"], REPO).out)).toBe(FIXTURES.version);
  expect(norm(run(["--help"], REPO).out)).toBe(FIXTURES.help);
});

test("state patch and stats match the frozen fixtures", async () => {
  expect(norm(await state(PORTS.main))).toEqual(norm(FIXTURES.stateHead));
  expect(norm(await state(PORTS.base))).toEqual(norm(FIXTURES.stateDevelop));
});

test("branches and invalid base match the frozen fixtures", async () => {
  const branches = await (await fetch(`http://127.0.0.1:${PORTS.main}/api/branches`)).json();
  expect(norm(branches)).toEqual(norm(FIXTURES.branches));
  const invalid = await (await post(PORTS.main, "/api/base", { base: "no-such-ref" })).json();
  expect(norm(invalid)).toEqual(norm(FIXTURES.invalidBase));
});

test("comment lifecycle matches the frozen fixtures", async () => {
  const add = run(["comment", "add", "--path", "src/app.ts", "--line", "2", "--body", "reset sum"], REPO);
  expect(norm(add.out)).toBe(FIXTURES.addOut);
  let thread = (await state(PORTS.main)).threads[0];
  await post(PORTS.main, `/api/threads/${thread.id}/send`, {});
  expect(norm((await state(PORTS.main)).threads[0])).toEqual(norm(FIXTURES.afterSend));
  thread = (await state(PORTS.main)).threads[0];
  expect(norm(run(["resolve", thread.id, "--reply", "fixed"], REPO).out)).toBe(FIXTURES.resolveOut);
  thread = (await state(PORTS.main)).threads[0];
  await post(PORTS.main, `/api/threads/${thread.id}/reply`, { body: "not fixed yet" });
  expect(norm((await state(PORTS.main)).threads[0])).toEqual(norm(FIXTURES.afterReply));
  expect(norm(run(["comments"], REPO).out)).toBe(FIXTURES.commentsHuman);
  expect(norm(JSON.parse(run(["comments", "--json"], REPO).out))).toEqual(norm(JSON.parse(FIXTURES.commentsJson)));
  thread = (await state(PORTS.main)).threads[0];
  expect(norm(run(["comment", "note", thread.id, "--body", "also check caller"], REPO).out)).toBe(FIXTURES.noteOut);
  expect(norm(run(["status"], REPO).out)).toBe(norm(FIXTURES.status));
  thread = (await state(PORTS.main)).threads[0];
  await post(PORTS.main, `/api/threads/${thread.id}/dismiss`, {});
  expect(norm((await state(PORTS.main)).threads[0])).toEqual(norm(FIXTURES.afterDismiss));
});

test("multi-repo routing matches the frozen fixtures", async () => {
  const add = run(["comment", "add", "--path", "src/other.ts", "--line", "1", "--body", "second repo"], REPO2);
  expect(norm(add.out)).toBe(FIXTURES.addSecondOut);
  expect(norm(JSON.parse(run(["comments", "--json"], REPO2).out))).toEqual(norm(JSON.parse(FIXTURES.commentsSecond)));
  expect(norm(JSON.parse(run(["comments", "--json"], REPO).out))).toEqual(norm(JSON.parse(FIXTURES.commentsFirst)));
});

test("sessions, grammars, upgrade check, and validation match the frozen fixtures", () => {
  const sessions = (text: string) => norm(text).split("\n").filter(Boolean).sort().join("\n");
  expect(sessions(run(["sessions"], REPO).out)).toBe(sessions(FIXTURES.sessions));
  expect(norm(run(["grammars"], REPO).out)).toBe(FIXTURES.grammars);
  expect(norm(run(["upgrade", "--check"], REPO).out)).toBe(norm(FIXTURES.upgradeCheck));
  const bad = run(["--repo"], REPO);
  expect(norm(bad.out)).toBe(FIXTURES.badRepoOut);
  expect(bad.err.includes("--repo needs a path")).toBe(true);
  expect(FIXTURES.badRepoErr).toBe("--repo needs a path");
  expect(bad.code).toBe(FIXTURES.badRepoCode);
});

test("SSE stream emits connected", async () => {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${PORTS.main}/api/events`, { signal: controller.signal });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const { value } = await response.body!.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("connected");
  controller.abort();
});

test("injected context refreshes when the working tree changes", async () => {
  const path = join(REPO, "src/flow.ts");
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, original.replace("export function flow", "export function changedFlow"));
    expect((await state(PORTS.main)).patch).toContain("export function changedFlow");
  } finally {
    writeFileSync(path, original);
  }
  expect((await state(PORTS.main)).patch).toContain("export function flow");
});

test("stale threads recover and are visible to the agent", async () => {
  const path = join(REPO, "src/app.ts");
  const original = readFileSync(path, "utf8");
  const thread = await post(PORTS.main, "/api/threads", {
    path: "src/app.ts", line: 2, side: "additions", anchor: "  let sum = 0;", body: "stale check",
  }).then((response) => response.json()) as { id: string };
  const status = async () => (await state(PORTS.main)).threads.find((t) => t.id === thread.id)?.status;
  try {
    expect(await status()).toBe("open");
    writeFileSync(path, "// moved\n".repeat(25) + original);
    expect(await status()).toBe("stale");
    const pulled = JSON.parse(run(["comments", "--json"], REPO).out) as { id: string; status: string }[];
    expect(pulled.find((t) => t.id === thread.id)?.status).toBe("stale");
  } finally {
    writeFileSync(path, original);
  }
  expect(await status()).toBe("open");
});

test("thread ids are unique and a send only changes its own thread", async () => {
  const add = async (body: string) => (await post(PORTS.main, "/api/threads", {
    path: "src/app.ts", line: 2, side: "additions", body,
  }).then((response) => response.json())) as { id: string };
  const first = await add("first");
  const second = await add("second");
  expect(first.id).not.toBe(second.id);
  await post(PORTS.main, `/api/threads/${first.id}/send`, {});
  const list = await (await fetch(`http://127.0.0.1:${PORTS.main}/api/threads`)).json() as { id: string; status: string }[];
  expect(list.find((thread) => thread.id === first.id)?.status).toBe("sent");
  expect(list.find((thread) => thread.id === second.id)?.status).toBe("open");
});

test("branch switches and new files refresh the diff", async () => {
  const repo = join(TMP, "branch-repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/main.ts"), "export const main = 1;\n");
  sh("git init -q -b main && git config user.email t@t && git config user.name T && git add . && git commit -qm init", repo);
  sh("git checkout -q -b feature", repo);
  writeFileSync(join(repo, "src/main.ts"), "export const main = 2;\n");
  writeFileSync(join(repo, "src/only.ts"), "export const only = true;\n");
  sh("git add . && git commit -qm feature && git checkout -q main", repo);
  const port = await freePort();
  await start(repo, port, "main");
  expect((await state(port)).stats.files).toBe(0);

  expect(await diffAfter(port, () => sh("git checkout -q feature", repo))).toBe(true);
  const switched = await state(port);
  expect(switched.stats.files).toBe(2);
  expect(switched.patch).toContain("export const only = true;");

  sh("git checkout -q main", repo);
  writeFileSync(join(repo, "src/extra.ts"), "export const extra = true;\n");
  const added = await state(port);
  expect(added.stats.files).toBe(1);
  expect(added.patch).toContain("export const extra = true;");
});

test("state stays out of the repository when HOME is unset", async () => {
  const repo = join(TMP, "home-repo");
  const tmp = join(TMP, "tmp-home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  sh("git init -q -b main && git config user.email t@t && git config user.name T && git add . && git commit -qm init", repo);
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  for (const key of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) delete env[key];
  const port = await freePort();
  const proc = Bun.spawn([BIN, "--repo", repo, "--port", String(port), "--no-open"], {
    env, stdout: "ignore", stderr: "ignore",
  });
  servers.push(proc);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect((await state(port)).stats.files).toBe(1);
  expect(readdirSync(repo).filter((name) => [".config", ".cache", ".local"].includes(name))).toEqual([]);
  expect(readFileSync(join(tmp, ".config/diffloop/daemons.json"), "utf8")).toContain(repo);
});
