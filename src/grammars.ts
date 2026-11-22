import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { WASM } from "./embedded";

export interface GrammarDef {
  file: string;
  extensions: string[];
  url?: string;
  localPath?: string;
}

const cdn = (pkg: string, version: string, file: string) =>
  `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${file}`;

export const downloadableGrammars: GrammarDef[] = [
  { file: "tree-sitter-c_sharp.wasm", extensions: [".cs"], url: cdn("tree-sitter-c-sharp", "0.24.0", "tree-sitter-c_sharp.wasm") },
  { file: "tree-sitter-go.wasm", extensions: [".go"], url: cdn("tree-sitter-go", "0.25.0", "tree-sitter-go.wasm") },
  { file: "tree-sitter-rust.wasm", extensions: [".rs"], url: cdn("tree-sitter-rust", "0.24.0", "tree-sitter-rust.wasm") },
  { file: "tree-sitter-python.wasm", extensions: [".py"], url: cdn("tree-sitter-python", "0.25.0", "tree-sitter-python.wasm") },
  { file: "tree-sitter-java.wasm", extensions: [".java"], url: cdn("tree-sitter-java", "0.23.5", "tree-sitter-java.wasm") },
  { file: "tree-sitter-c.wasm", extensions: [".c", ".h"], url: cdn("tree-sitter-c", "0.24.1", "tree-sitter-c.wasm") },
  { file: "tree-sitter-cpp.wasm", extensions: [".cc", ".cpp", ".cxx", ".hpp"], url: cdn("tree-sitter-cpp", "0.23.4", "tree-sitter-cpp.wasm") },
  { file: "tree-sitter-ruby.wasm", extensions: [".rb"], url: cdn("tree-sitter-ruby", "0.23.1", "tree-sitter-ruby.wasm") },
  { file: "tree-sitter-php.wasm", extensions: [".php"], url: cdn("tree-sitter-php", "0.24.2", "tree-sitter-php.wasm") },
  { file: "tree-sitter-scala.wasm", extensions: [".scala"], url: cdn("tree-sitter-scala", "0.24.0", "tree-sitter-scala.wasm") },
  { file: "tree-sitter-dart.wasm", extensions: [".dart"], url: cdn("tree-sitter-dart", "1.0.0", "tree-sitter-dart.wasm") },
  { file: "tree-sitter-elixir.wasm", extensions: [".ex", ".exs"], url: cdn("tree-sitter-elixir", "0.3.5", "tree-sitter-elixir.wasm") },
  { file: "tree-sitter-haskell.wasm", extensions: [".hs"], url: cdn("tree-sitter-haskell", "0.23.1", "tree-sitter-haskell.wasm") },
  { file: "tree-sitter-ocaml.wasm", extensions: [".ml"], url: cdn("tree-sitter-ocaml", "0.24.2", "tree-sitter-ocaml.wasm") },
  { file: "tree-sitter-solidity.wasm", extensions: [".sol"], url: cdn("tree-sitter-solidity", "1.2.13", "tree-sitter-solidity.wasm") },
  { file: "tree-sitter-svelte.wasm", extensions: [".svelte"], url: cdn("tree-sitter-svelte", "0.11.0", "tree-sitter-svelte.wasm") },
  { file: "tree-sitter-bash.wasm", extensions: [".sh", ".bash"], url: cdn("tree-sitter-bash", "0.25.1", "tree-sitter-bash.wasm") },
  { file: "tree-sitter-toml.wasm", extensions: [".toml"], url: cdn("@tree-sitter-grammars/tree-sitter-toml", "0.7.0", "tree-sitter-toml.wasm") },
];

const configPath = () => join(homedir(), ".config", "diffloop", "grammars.json");
const cacheDir = () => join(homedir(), ".cache", "diffloop", "grammars");

async function definitions(): Promise<Map<string, GrammarDef>> {
  const map = new Map<string, GrammarDef>();
  for (const grammar of downloadableGrammars) {
    for (const ext of grammar.extensions) map.set(ext, grammar);
  }
  for (const [file, base64] of Object.entries(WASM)) {
    if (file === "web-tree-sitter.wasm") continue;
    for (const ext of extensionFor(file)) {
      map.set(ext, { file, extensions: [ext] });
    }
  }
  try {
    const custom = JSON.parse(await readFile(configPath(), "utf8")) as GrammarDef[];
    for (const grammar of custom) {
      if (!grammar.file) continue;
      for (const ext of grammar.extensions ?? []) map.set(ext, grammar);
    }
  } catch {
    // No custom grammar config yet.
  }
  return map;
}

function extensionFor(file: string): string[] {
  const embedded: Record<string, string[]> = {
    "tree-sitter-javascript.wasm": [".js", ".jsx", ".mjs", ".cjs"],
    "tree-sitter-typescript.wasm": [".ts"],
    "tree-sitter-tsx.wasm": [".tsx"],
    "tree-sitter-html.wasm": [".html", ".htm"],
    "tree-sitter-css.wasm": [".css", ".scss"],
    "tree-sitter-json.wasm": [".json"],
    "tree-sitter-xml.wasm": [".xml", ".svg", ".xsd", ".xsl"],
    "tree-sitter-SQL.wasm": [".sql"],
    "tree-sitter-markdown.wasm": [".md"],
    "tree-sitter-yaml.wasm": [".yaml", ".yml"],
    "tree-sitter-vue.wasm": [".vue"],
    "tree-sitter-perl.wasm": [".pl", ".pm"],
  };
  return embedded[file] ?? [];
}

let initialization: Promise<{ dir: string; parserReady: boolean }> | null = null;
const languageCache = new Map<string, Language | null>();

async function initialize() {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  for (const [file, base64] of Object.entries(WASM)) {
    await writeFile(join(dir, file), Buffer.from(base64, "base64"));
  }
  await Parser.init({ locateFile: (file: string) => join(dir, file) });
  return { dir, parserReady: true };
}

async function ensureAvailable(def: GrammarDef, dir: string): Promise<boolean> {
  const target = join(dir, def.file);
  try {
    await readFile(target);
    return true;
  } catch {
    // fall through
  }
  if (def.localPath) {
    await copyFile(def.localPath, target);
    return true;
  }
  if (!def.url) return false;
  console.log(`diffloop: downloading grammar ${def.file}`);
  const response = await fetch(def.url);
  if (!response.ok) return false;
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return true;
}

export async function parserForPath(path: string) {
  const ext = path.slice(path.lastIndexOf("."));
  const def = (await definitions()).get(ext);
  if (!def) return null;
  const state = await (initialization ??= initialize());
  if (languageCache.has(def.file)) {
    const cached = languageCache.get(def.file);
    if (!cached) return null;
    const parser = new Parser();
    parser.setLanguage(cached);
    return parser;
  }
  if (!(await ensureAvailable(def, state.dir))) {
    languageCache.set(def.file, null);
    return null;
  }
  try {
    const language = await Language.load(join(state.dir, def.file));
    languageCache.set(def.file, language);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  } catch {
    languageCache.set(def.file, null);
    return null;
  }
}

export async function grammarStatus() {
  const extensionsByFile = new Map<string, string[]>();
  for (const [ext, def] of await definitions()) {
    const current = extensionsByFile.get(def.file) ?? [];
    current.push(ext);
    extensionsByFile.set(def.file, current);
  }
  return Promise.all(
    [...extensionsByFile].map(async ([file, extensions]) => {
      let cached = false;
      try {
        await stat(join(cacheDir(), file));
        cached = true;
      } catch {
        // not downloaded yet
      }
      return { file, extensions, embedded: Boolean(WASM[file]), cached };
    }),
  );
}
