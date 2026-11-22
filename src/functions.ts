import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parserForPath } from "./grammars";

export interface FunctionContext {
  id: string;
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  header: string;
  firstLines: string[];
  fullText: string;
  changedLines: number[];
}

const functionNodeTypes = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "function",
  "local_function",
  "local_function_statement",
  "method",
  "singleton_method",
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "class_declaration",
  "class_definition",
  "class_specifier",
  "struct_specifier",
  "struct_declaration",
  "interface_declaration",
  "enum_declaration",
  "impl_item",
  "module",
  "namespace_declaration",
]);

export function changedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = line.split(" b/").at(-1);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

function changedLines(patch: string, path: string): number[] {
  const result: number[] = [];
  let currentPath = "";
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = line.split(" b/").at(-1) ?? "";
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      newLine = Number(line.match(/\+(\d+)/)?.[1] ?? 0);
      inHunk = currentPath === path;
    } else if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      result.push(newLine++);
    } else if (inHunk && line.startsWith(" ")) {
      newLine++;
    }
  }
  return result;
}

export async function functionContexts(
  repo: string,
  patch: string,
  paths: string[],
): Promise<FunctionContext[]> {
  const result: FunctionContext[] = [];
  for (const path of paths) {
    let contents: string;
    try {
      contents = await readFile(join(repo, path), "utf8");
    } catch {
      continue;
    }
    const parser = await parserForPath(path);
    if (!parser) continue;
    const tree = parser.parse(contents);
    if (!tree) continue;
    const sourceLines = contents.split("\n");
    const touched = changedLines(patch, path);
    if (touched.length === 0) continue;

    const walk = (node: any) => {
      if (functionNodeTypes.has(node.type)) {
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        const relevant = touched.filter((line) => line >= start && line <= end);
        if (relevant.length > 0) {
          const name = node.childByFieldName?.("name")?.text?.split("\n")[0] ?? node.type;
          result.push({
            id: `${path}:${start}:${name}`,
            path,
            name,
            startLine: start,
            endLine: end,
            header: sourceLines[start - 1]?.trim() ?? "",
            firstLines: sourceLines.slice(start - 1, start + 9),
            fullText: sourceLines.slice(start - 1, Math.min(end, start + 199)).join("\n"),
            changedLines: relevant,
          });
        }
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);
  }

  const innermost: FunctionContext[] = [];
  const claimed = new Set<string>();
  for (const fn of result.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))) {
    const lines = fn.changedLines.filter((line) => !claimed.has(`${fn.path}:${line}`));
    if (lines.length === 0) continue;
    for (const line of lines) claimed.add(`${fn.path}:${line}`);
    innermost.push({ ...fn, changedLines: lines });
  }
  return innermost;
}
