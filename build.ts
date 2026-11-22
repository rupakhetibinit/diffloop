import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const result = await Bun.build({
  entrypoints: ["web/main.ts"],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

const js = await result.outputs[0].text();
const html = await Bun.file("web/index.html").text();
const css = await Bun.file("web/style.css").text();

const embeddedGrammars = [
  "web-tree-sitter/web-tree-sitter.wasm",
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  "tree-sitter-html/tree-sitter-html.wasm",
  "tree-sitter-css/tree-sitter-css.wasm",
  "tree-sitter-json/tree-sitter-json.wasm",
];

const wasmPaths = [
  ...embeddedGrammars.map((path) => join("node_modules", path)),
  ...(await readdir(".")).filter((name) => name.endsWith(".wasm")),
];
const wasm: Record<string, string> = {};
for (const path of [...new Set(wasmPaths)]) {
  const bytes = await Bun.file(path).arrayBuffer();
  wasm[path.split("/").at(-1)!] = Buffer.from(bytes).toString("base64");
}
console.log(`embedding ${Object.keys(wasm).length} wasm modules`);

await Bun.write(
  "src/embedded.ts",
  `export const HTML = ${JSON.stringify(html)};\nexport const JS = ${JSON.stringify(js)};\nexport const CSS = ${JSON.stringify(css)};\nexport const WASM: Record<string, string> = ${JSON.stringify(wasm)};\n`,
);

await $`bun build --compile src/main.ts --outfile diffloop`;
console.log("built ./diffloop");
