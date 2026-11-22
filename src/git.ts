import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FunctionContext } from "./functions";

async function git(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !err.includes("ambiguous argument 'HEAD'")) {
    throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  }
  return out;
}

function untrackedPatch(repo: string, path: string, contents: string): string {
  if (contents.includes("\0")) return "";
  const lines = contents.split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  if (lines.length === 0) return "";
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    trailingNewline ? "" : "\\ No newline at end of file",
    "",
  ].join("\n");
}

export async function buildPatch(repo: string, base = "HEAD"): Promise<string> {
  const root = resolve(repo);
  const tracked = await git(root, [
    "diff", "--no-ext-diff", "--no-color", "--unified=3", base, "--",
  ]);
  const raw = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = raw.split("\0").filter(Boolean);
  const additions: string[] = [];
  for (const path of paths) {
    const full = isAbsolute(path) ? path : join(root, path);
    let contents: string;
    try {
      contents = await readFile(full, "utf8");
    } catch {
      continue;
    }
    additions.push(untrackedPatch(root, path, contents));
  }
  return `${tracked}${additions.join("")}`;
}

export function patchHash(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

export async function workingLines(repo: string, path: string): Promise<string[]> {
  try {
    const contents = await readFile(join(repo, path), "utf8");
    return contents.split("\n");
  } catch {
    return [];
  }
}

export async function headLines(repo: string, path: string, base = "HEAD"): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repo, "show", `${base}:${path}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out ? out.split("\n") : [];
}

const FUNCTION_HEADER_LINES = 1;
const BLOCK_HEADER_LINES = 4;

export async function augmentPatch(
  repo: string,
  patch: string,
  functions: FunctionContext[],
  base = "HEAD",
): Promise<string> {
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const result: string[] = [];

  for (const section of sections) {
    const path = section.split(" b/")[0]?.split("diff --git a/")[1] ?? "";
    const lines = section.replace(/\n$/, "").split("\n");
    const hunkStarts = lines.flatMap((line, index) => (line.startsWith("@@ ") ? [index] : []));
    if (hunkStarts.length === 0) {
      result.push(section);
      continue;
    }
    const header = lines.slice(0, hunkStarts[0]);
    const hunks: string[][] = [];
    for (let i = 0; i < hunkStarts.length; i++) {
      const end = hunkStarts[i + 1] ?? lines.length;
      hunks.push(lines.slice(hunkStarts[i], end));
    }

    const newLines = await workingLines(repo, path);
    const oldLines = await headLines(repo, path, base);
    const insertions: { start: number; text: string }[] = [];
    const contextHunk = (start: number, count: number) => {
      const body: string[] = [];
      for (let offset = 0; offset < count; offset++) {
        const lineNumber = start + offset;
        const text = newLines[lineNumber - 1] ?? oldLines[lineNumber - 1] ?? "";
        body.push(` ${text}`);
      }
      return [`@@ -${start},${count} +${start},${count} @@`, ...body].join("\n");
    };

    const scopes = functions
      .filter((fn) => fn.path === path && fn.changedLines.length > 0)
      .sort((a, b) => a.startLine - b.startLine || (a.level === "function" ? -1 : 1));
    let occupiedUntil = 0;
    for (const scope of scopes) {
      const start = scope.startLine;
      if (start <= occupiedUntil || newLines.length === 0) continue;
      const nextHunk = Math.min(
        Infinity,
        ...hunks
          .map((hunk) => Number(hunk[0]?.match(/\+(\d+)/)?.[1] ?? 0))
          .filter((line) => line >= start),
      );
      const firstChanged = Math.min(...scope.changedLines);
      const desired = scope.level === "function" ? FUNCTION_HEADER_LINES : BLOCK_HEADER_LINES;
      const count = Math.max(0, Math.min(start + desired, nextHunk, firstChanged, scope.endLine + 1) - start);
      if (count > 0) {
        insertions.push({ start, text: contextHunk(start, count) });
        occupiedUntil = start + count - 1;
      }
      for (const extra of scope.extraLines) {
        if (extra <= occupiedUntil || extra >= firstChanged || extra >= nextHunk) continue;
        insertions.push({ start: extra, text: contextHunk(extra, 1) });
        occupiedUntil = extra;
      }
    }

    const ordered: string[] = [...header];
    for (const hunk of hunks) {
      const hunkStart = Number(hunk[0]?.match(/\+(\d+)/)?.[1] ?? 0);
      for (const insertion of insertions.filter((item) => item.start < hunkStart).sort((a, b) => a.start - b.start)) {
        ordered.push(insertion.text);
      }
      ordered.push(hunk.join("\n"));
    }
    const lastHunkStart = Number(hunks.at(-1)?.[0]?.match(/\+(\d+)/)?.[1] ?? 0);
    for (const insertion of insertions.filter((item) => item.start >= lastHunkStart).sort((a, b) => a.start - b.start)) {
      ordered.push(insertion.text);
    }
    result.push(ordered.join("\n"));
  }
  return `${result.join("\n")}\n`;
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ["branch", "--all", "--format=%(refname:short)"]);
  return [...new Set(out.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

export async function reanchor(
  repo: string,
  thread: { path: string; line: number; anchor: string },
): Promise<number | null> {
  const lines = await workingLines(repo, thread.path);
  if (lines.length === 0) return null;
  const needle = thread.anchor.trim();
  if (lines[thread.line - 1]?.trim() === needle) return thread.line;
  for (let distance = 1; distance <= 20; distance++) {
    const below = lines[thread.line - 1 + distance]?.trim();
    if (below === needle) return thread.line + distance;
    const above = lines[thread.line - 1 - distance]?.trim();
    if (above === needle) return thread.line - distance;
  }
  return null;
}
