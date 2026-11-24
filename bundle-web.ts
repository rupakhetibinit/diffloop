const result = await Bun.build({
  entrypoints: ["web/main.tsx"],
  target: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
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
await Bun.write("rust/assets/favicon.svg", await Bun.file("web/favicon.svg").text());
