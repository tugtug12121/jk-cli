import { spawn } from "child_process";
import path from "path";
import os from "os";
import crypto from "crypto";
import fs from "fs";
import fetch from "node-fetch";

export default async function install(pkgs) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🚀  jk secure installer");
  console.log(`  → Installing: ${pkgs.join(", ")}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  for (const pkg of pkgs) {
    if (pkg.startsWith("github:")) {
      await installFromGitHub(pkg.replace("github:", ""));
    } else {
      await installFromNpm(pkg);
    }
  }

  console.log("");
  console.log("✨ Installation complete");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}

// ---------------------------------------------------------
// NPM INSTALL
// ---------------------------------------------------------
async function installFromNpm(pkg) {
  const isWin = os.platform() === "win32";

  const cmd = isWin
    ? ["cmd.exe", ["/c", "npm", "install", pkg]]
    : ["npm", ["install", pkg]];

  return new Promise(resolve => {
    const child = spawn(...cmd, { stdio: "inherit" });
    child.on("close", () => resolve());
  });
}

// ---------------------------------------------------------
// GITHUB INSTALL
// ---------------------------------------------------------
async function installFromGitHub(repoSpec) {
  const [repo, version = "latest"] = repoSpec.split("@");

  const apiUrl =
    version === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${version}`;

  const res = await fetch(apiUrl);
  if (!res.ok) {
    console.log(`❌ Failed to fetch release for ${repo}`);
    return;
  }

  const release = await res.json();
  const asset = release.assets?.[0];
  if (!asset) {
    console.log(`❌ No downloadable assets found for ${repo}`);
    return;
  }

  const url = asset.browser_download_url;
  const file = path.join(os.tmpdir(), asset.name);

  console.log(`📥 Downloading ${asset.name}...`);
  await downloadFile(url, file);

  console.log(`🔐 Verifying integrity...`);
  const ok = await verifySha256(repo, release.tag_name, file);
  if (!ok) {
    console.log("❌ Integrity check failed");
    return;
  }

  console.log(`📦 Installing ${repo}...`);
  // You can add extraction logic here (zip, tar, etc.)
}

// ---------------------------------------------------------
// DOWNLOAD FILE
// ---------------------------------------------------------
async function downloadFile(url, dest) {
  const res = await fetch(url);
  const file = fs.createWriteStream(dest);

  return new Promise(resolve => {
    res.body.pipe(file);
    res.body.on("end", resolve);
  });
}

// ---------------------------------------------------------
// SHA256 VERIFICATION
// ---------------------------------------------------------
async function verifySha256(repo, version, file) {
  const checksumUrl = `https://raw.githubusercontent.com/${repo}/${version}/checksum.sha256`;

  try {
    const res = await fetch(checksumUrl);
    if (!res.ok) return false;

    const expected = (await res.text()).trim();
    const actual = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");

    return expected === actual;
  } catch {
    return false;
  }
}
