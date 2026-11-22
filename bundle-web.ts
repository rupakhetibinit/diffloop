const result = await Bun.build({
  entrypoints: ["web/main.ts"],
  target: "browser",
  format: "iife",
  minify: true,
  outdir: "rust/assets",
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
const output = result.outputs[0];
await Bun.write("rust/assets/app.js", await output.text());
await Bun.write("rust/assets/index.html", (await Bun.file("web/index.html").text()).replace("/app.css", "/app.css"));
await Bun.write("rust/assets/app.css", await Bun.file("web/style.css").text());
