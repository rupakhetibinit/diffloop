import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO = "rupakhetibinit/diffloop";

interface Release {
  version: string;
  tag: string;
  asset: { name: string; url: string };
}

function assetName(): string {
  if (process.platform === "win32") return "diffloop-windows-x64.exe";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "diffloop-darwin-arm64" : "diffloop-darwin-x64";
  }
  return process.arch === "arm64" ? "diffloop-linux-arm64" : "diffloop-linux-x64";
}

export function newerVersion(current: string, latest: string): boolean {
  const parts = (value: string) => value.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
  const a = parts(current);
  const b = parts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

export async function latestRelease(): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "diffloop-upgrade", Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const data = (await response.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const name = assetName();
  const asset = data.assets.find((item) => item.name === name);
  if (!asset) throw new Error(`release ${data.tag_name} has no asset for ${process.platform}/${process.arch}`);
  return {
    version: data.tag_name.replace(/^v/, ""),
    tag: data.tag_name,
    asset: { name, url: asset.browser_download_url },
  };
}

export async function installUpgrade(release: Release): Promise<void> {
  const target = process.execPath;
  const extension = process.platform === "win32" ? ".exe" : "";
  const staged = join(dirname(target), `diffloop-new-${process.pid}${extension}`);
  const response = await fetch(release.asset.url);
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  await writeFile(staged, Buffer.from(await response.arrayBuffer()));
  if (process.platform !== "win32") await chmod(staged, 0o755);

  if (process.platform === "win32") {
    const quote = (value: string) => value.replace(/'/g, "''");
    const script = [
      `Start-Sleep -Milliseconds 800`,
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }`,
      `Move-Item -Force -LiteralPath '${quote(staged)}' -Destination '${quote(target)}'`,
    ].join("; ");
    Bun.spawn(
      ["cmd", "/c", "start", "/b", "powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
      { stdout: "ignore", stderr: "ignore" },
    );
    return;
  }
  await rename(staged, target);
}
