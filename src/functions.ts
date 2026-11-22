import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parserForPath } from "./grammars";

export type ScopeLevel = "function" | "block";

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
  level: ScopeLevel;
  kind: string;
  extraLines: number[];
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

const blockNodeTypes = new Set([
  "for_statement",
  "for_in_statement",
  "for_expression",
  "foreach_statement",
  "while_statement",
  "while_expression",
  "do_statement",
  "loop_expression",
  "if_statement",
  "if_expression",
  "switch_statement",
  "switch_expression",
  "match_expression",
  "try_statement",
  "using_statement",
  "lock_statement",
  "repeat_statement",
  "select_statement",
]);

const clauseTypes = new Set(["catch_clause", "finally_clause", "else_clause", "except_clause"]);

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
  const all: FunctionContext[] = [];
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

    const scopes: { node: any; level: ScopeLevel }[] = [];
    const clauses: { type: string; startLine: number }[] = [];
    const walk = (node: any) => {
      if (functionNodeTypes.has(node.type)) scopes.push({ node, level: "function" });
      if (blockNodeTypes.has(node.type)) scopes.push({ node, level: "block" });
      if (clauseTypes.has(node.type)) {
        clauses.push({ type: node.type, startLine: node.startPosition.row + 1 });
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    const contexts = new Map<string, FunctionContext>();
    for (const line of touched) {
      for (const level of ["block", "function"] as ScopeLevel[]) {
        const candidates = scopes
          .filter(({ node, level: candidateLevel }) => {
            if (candidateLevel !== level) return false;
            const start = node.startPosition.row + 1;
            const end = node.endPosition.row + 1;
            return line >= start && line <= end;
          })
          .sort((a, b) =>
            a.node.endPosition.row - a.node.startPosition.row -
            (b.node.endPosition.row - b.node.startPosition.row),
          );
        const match = candidates[0];
        if (!match) continue;
        const { node } = match;
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        const key = `${level}:${start}:${node.type}`;
        let context = contexts.get(key);
        if (!context) {
          const header = sourceLines[start - 1]?.trim() ?? "";
          const name = node.childByFieldName?.("name")?.text?.split("\n")[0] ?? header.slice(0, 80) ?? node.type;
          context = {
            id: `${path}:${start}:${node.type}`,
            path,
            name,
            startLine: start,
            endLine: end,
            header,
            firstLines: sourceLines.slice(start - 1, start + 9),
            fullText: sourceLines.slice(start - 1, Math.min(end, start + 199)).join("\n"),
            changedLines: [],
            level,
            kind: node.type,
            extraLines: [],
          };
          contexts.set(key, context);
        }
        if (!context.changedLines.includes(line)) context.changedLines.push(line);
      }
    }

    for (const context of contexts.values()) {
      if (context.level !== "block") continue;
      const paired =
        context.kind.includes("try") ? ["catch_clause", "finally_clause", "except_clause"]
          : context.kind.includes("if") ? ["else_clause"] : [];
      for (const clause of clauses) {
        if (!paired.includes(clause.type)) continue;
        if (clause.startLine <= context.startLine || clause.startLine > context.endLine + 1) continue;
        if (!context.extraLines.includes(clause.startLine)) context.extraLines.push(clause.startLine);
      }
      context.extraLines.sort((a, b) => a - b);
    }
    all.push(...contexts.values());
  }
  return all.sort((a, b) => a.startLine - b.startLine);
}
