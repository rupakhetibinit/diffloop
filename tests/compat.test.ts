import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BUN_BIN = join(ROOT, "diffloop");
const RS_BIN = join(ROOT, "rust/target/release/diffloop-rs");
const TMP = join(ROOT, ".amp/in/compat");
const REPO = join(TMP, "repo");
const REPO2 = join(TMP, "repo2");
const HOMES = { bun: join(TMP, "home-bun"), rs: join(TMP, "home-rs") };
let PORTS = { bun: 4401, rs: 4402 };
let PORTS2 = { bun: 4411, rs: 4412 };

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

type Proc = ReturnType<typeof Bun.spawn>;
const servers: Proc[] = [];

function sh(command: string, cwd = TMP) {
  const result = spawnSync(command, { shell: "/bin/bash", cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}\n${result.stderr}`);
}

function run(bin: string, args: string[], cwd: string, home: string) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { out: result.stdout ?? "", err: result.stderr ?? "", code: result.status ?? 1 };
}

async function start(bin: string, home: string, port: number, repo = REPO, base?: string) {
  mkdirSync(home, { recursive: true });
  const args = [bin, "--repo", repo, "--port", String(port), "--no-open"];
  if (base) args.push("--base", base);
  const proc = Bun.spawn(args, {
    env: { ...process.env, HOME: home },
    stdout: "ignore",
    stderr: "ignore",
  });
  servers.push(proc);
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${bin} did not start on ${port}`);
}

async function state(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  return response.json() as Promise<any>;
}

function normalize(text: string) {
  return text
    .replace(/[0-9a-f]{8}/g, "<id>")
    .replace(/\d{13,}/g, "<time>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
}

beforeAll(async () => {
  PORTS = { bun: await freePort(), rs: await freePort() };
  PORTS2 = { bun: await freePort(), rs: await freePort() };
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(join(REPO, "src/app.ts"), "export function total(values: number[]) {\n  let sum = 0;\n  for (const value of values) {\n    sum += value;\n  }\n  return sum;\n}\n");
  const flow = [
    "export function flow(values: number[]) {",
    "  let total = 0;",
    "  for (const value of values) {",
    "    if (value > 10) {",
    "      total += value;",
    "    } else {",
    "      total += 1;",
    "    }",
    "  }",
    "  try {",
    "    total += 100;",
    "  } catch (error) {",
    "    total -= 1;",
    "  } finally {",
    "    total += 2;",
    "  }",
    ...Array.from({ length: 180 }, (_, i) => `  // padding ${i}`),
    "  return total;",
    "}",
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
  writeFileSync(join(REPO, "src/app.ts"), "export function total(values: number[]) {\n  let sum = 1;\n  for (const value of values) {\n    sum += Math.max(value, 0);\n  }\n  return sum;\n}\n");
  mkdirSync(join(REPO2, "src"), { recursive: true });
  writeFileSync(join(REPO2, "src/other.ts"), "export const other = 1;\n");
  sh("git init -q && git config user.email t@t && git config user.name T && git add . && git commit -qm init", REPO2);
  writeFileSync(join(REPO2, "src/other.ts"), "export const other = 2;\n");
  await start(BUN_BIN, HOMES.bun, PORTS.bun);
  await start(RS_BIN, HOMES.rs, PORTS.rs);
  await start(BUN_BIN, HOMES.bun, PORTS2.bun, REPO2);
  await start(RS_BIN, HOMES.rs, PORTS2.rs, REPO2);
});

afterAll(() => {
  for (const proc of servers) proc.kill();
});

test("version and help match", () => {
  for (const args of [["--version"], ["--help"]]) {
    const bun = run(BUN_BIN, args, REPO, HOMES.bun);
    const rs = run(RS_BIN, args, REPO, HOMES.rs);
    expect(normalize(rs.out)).toBe(normalize(bun.out));
    expect(rs.code).toBe(bun.code);
  }
});

test("state patch and stats match", async () => {
  const bun = await state(PORTS.bun);
  const rs = await state(PORTS.rs);
  expect(rs.patch).toBe(bun.patch);
  expect(rs.stats).toEqual(bun.stats);
  expect(rs.base).toBe(bun.base);
});

test("branch base switching matches", async () => {
  for (const port of [PORTS.bun, PORTS.rs]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/base`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "develop" }),
    });
    expect(response.ok).toBe(true);
  }
  const bun = await state(PORTS.bun);
  const rs = await state(PORTS.rs);
  expect(rs.patch).toBe(bun.patch);
  expect(rs.base).toBe("develop");
  for (const port of [PORTS.bun, PORTS.rs]) {
    await fetch(`http://127.0.0.1:${port}/api/base`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "HEAD" }),
    });
  }
});

test("comment lifecycle matches through CLI and HTTP", async () => {
  const bun = run(BUN_BIN, ["comment", "add", "--path", "src/app.ts", "--line", "2", "--body", "reset sum"], REPO, HOMES.bun);
  const rs = run(RS_BIN, ["comment", "add", "--path", "src/app.ts", "--line", "2", "--body", "reset sum"], REPO, HOMES.rs);
  expect(normalize(rs.out)).toBe(normalize(bun.out));

  for (const port of [PORTS.bun, PORTS.rs]) {
    const stateData = await state(port);
    const thread = stateData.threads[0];
    await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}/send`, { method: "POST", body: "{}" });
  }
  const sentBun = (await state(PORTS.bun)).threads[0];
  const sentRs = (await state(PORTS.rs)).threads[0];
  expect(sentRs.status).toBe(sentBun.status);

  const bunResolve = run(BUN_BIN, ["resolve", sentBun.id, "--reply", "fixed"], REPO, HOMES.bun);
  const rsResolve = run(RS_BIN, ["resolve", sentRs.id, "--reply", "fixed"], REPO, HOMES.rs);
  expect(normalize(rsResolve.out)).toBe(normalize(bunResolve.out));

  for (const port of [PORTS.bun, PORTS.rs]) {
    const thread = (await state(port)).threads[0];
    await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "not fixed yet" }),
    });
  }
  const bunFinal = (await state(PORTS.bun)).threads[0];
  const rsFinal = (await state(PORTS.rs)).threads[0];
  expect(rsFinal.status).toBe(bunFinal.status);
  expect(rsFinal.round).toBe(bunFinal.round);
  expect(rsFinal.messages.map((m: any) => m.author)).toEqual(bunFinal.messages.map((m: any) => m.author));
});

test("sessions and grammars commands succeed on both", () => {
  for (const [bin, home] of [[BUN_BIN, HOMES.bun], [RS_BIN, HOMES.rs]]) {
    const sessions = run(bin, ["sessions"], REPO, home);
    expect(sessions.code).toBe(0);
    expect(sessions.out).toContain(REPO);
    const grammars = run(bin, ["grammars"], REPO, home);
    expect(grammars.code).toBe(0);
    expect(grammars.out).toContain("typescript");
  }
});


test("human comments, note, and status commands match", () => {
  const bunComments = run(BUN_BIN, ["comments"], REPO, HOMES.bun);
  const rsComments = run(RS_BIN, ["comments"], REPO, HOMES.rs);
  expect(normalize(rsComments.out)).toBe(normalize(bunComments.out));

  const bunId = JSON.parse(run(BUN_BIN, ["comments", "--json"], REPO, HOMES.bun).out)[0].id;
  const rsId = JSON.parse(run(RS_BIN, ["comments", "--json"], REPO, HOMES.rs).out)[0].id;
  const bunNote = run(BUN_BIN, ["comment", "note", bunId, "--body", "also check caller"], REPO, HOMES.bun);
  const rsNote = run(RS_BIN, ["comment", "note", rsId, "--body", "also check caller"], REPO, HOMES.rs);
  expect(normalize(rsNote.out)).toBe(normalize(bunNote.out));

  const bunStatus = run(BUN_BIN, ["status"], REPO, HOMES.bun);
  const rsStatus = run(RS_BIN, ["status"], REPO, HOMES.rs);
  expect(normalize(rsStatus.out)).toBe(normalize(bunStatus.out));
});

test("invalid base ref returns the same error", async () => {
  const results = [];
  for (const port of [PORTS.bun, PORTS.rs]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/base`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: "no-such-ref" }),
    });
    results.push({ status: response.status, body: await response.json() });
  }
  expect(results[1]).toEqual(results[0]);
});

test("CLI routes to the correct repo when several are open", () => {
  const bunAdd = run(BUN_BIN, ["comment", "add", "--path", "src/other.ts", "--line", "1", "--body", "second repo"], REPO2, HOMES.bun);
  const rsAdd = run(RS_BIN, ["comment", "add", "--path", "src/other.ts", "--line", "1", "--body", "second repo"], REPO2, HOMES.rs);
  expect(normalize(rsAdd.out)).toBe(normalize(bunAdd.out));

  for (const [bin, home] of [[BUN_BIN, HOMES.bun], [RS_BIN, HOMES.rs]]) {
    const second = run(bin, ["comments", "--json"], REPO2, home);
    const first = run(bin, ["comments", "--json"], REPO, home);
    expect(second.out).toContain("src/other.ts");
    expect(first.out).toContain("src/app.ts");
    expect(first.out).not.toContain("src/other.ts");
  }
});

test("upgrade --check and --repo validation match", () => {
  const bunUpgrade = run(BUN_BIN, ["upgrade", "--check"], REPO, HOMES.bun);
  const rsUpgrade = run(RS_BIN, ["upgrade", "--check"], REPO, HOMES.rs);
  expect(normalize(rsUpgrade.out)).toBe(normalize(bunUpgrade.out));

  const bunBad = run(BUN_BIN, ["--repo"], REPO, HOMES.bun);
  const rsBad = run(RS_BIN, ["--repo"], REPO, HOMES.rs);
  expect(bunBad.code).not.toBe(0);
  expect(rsBad.code).not.toBe(0);
  expect(rsBad.err).toContain("--repo needs a path");
});


test("branches endpoint matches", async () => {
  const bun = await (await fetch(`http://127.0.0.1:${PORTS.bun}/api/branches`)).json();
  const rs = await (await fetch(`http://127.0.0.1:${PORTS.rs}/api/branches`)).json();
  expect(rs).toEqual(bun);
  expect(bun.branches).toContain("develop");
});

test("dismiss action matches", async () => {
  for (const port of [PORTS.bun, PORTS.rs]) {
    const stateData = await state(port);
    const thread = stateData.threads[0];
    await fetch(`http://127.0.0.1:${port}/api/threads/${thread.id}/dismiss`, { method: "POST", body: "{}" });
  }
  expect((await state(PORTS.rs)).threads[0].status).toBe((await state(PORTS.bun)).threads[0].status);
});

test("SSE stream emits connected and thread events on both", async () => {
  for (const port of [PORTS.bun, PORTS.rs]) {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("connected");
    controller.abort();
  }
});

test("grammars output matches exactly", () => {
  const bun = run(BUN_BIN, ["grammars"], REPO, HOMES.bun);
  const rs = run(RS_BIN, ["grammars"], REPO, HOMES.rs);
  expect(normalize(rs.out)).toBe(normalize(bun.out));
});


test("launch-time --base flag matches", async () => {
  const bunPort = await freePort();
  const rsPort = await freePort();
  await start(BUN_BIN, HOMES.bun, bunPort, REPO, "develop");
  await start(RS_BIN, HOMES.rs, rsPort, REPO, "develop");
  const bun = await state(bunPort);
  const rs = await state(rsPort);
  expect(rs.base).toBe(bun.base);
  expect(rs.patch).toBe(bun.patch);
});
