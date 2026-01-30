import { spawn } from "child_process";
import path from "path";
import os from "os";
import crypto from "crypto";
import fs from "fs";
import fetch from "node-fetch";

// ---------------------------------------------------------
// MAIN INSTALL ENTRY
// ---------------------------------------------------------
export default async function install(pkgs) {
  banner("jk secure installer", `Installing: ${pkgs.join(", ")}`);

  const results = [];

  for (const pkg of pkgs) {
    try {
      if (pkg.startsWith("github:")) {
        const result = await installFromGitHub(pkg.replace("github:", ""));
        results.push(result);
      } else {
        const result = await installFromNpm(pkg);
        results.push(result);
      }
    } catch (err) {
      results.push({ pkg, ok: false, error: err.message });
      console.log(`❌ Fatal error installing ${pkg}: ${err.message}`);
    }
  }

  summary(results);
}

// ---------------------------------------------------------
// NPM INSTALL (with verification + error handling)
// ---------------------------------------------------------
async function installFromNpm(pkg) {
  const isWin = os.platform() === "win32";
  const cmd = isWin
    ? ["cmd.exe", ["/c", "npm", "install", pkg]]
    : ["npm", ["install", pkg]];

  const before = snapshotDir("node_modules");

  const ok = await runCommand(cmd);
  if (!ok) return { pkg, ok: false, reason: "npm failed" };

  const after = snapshotDir("node_modules");

  if (before === after) {
    return { pkg, ok: false, reason: "no changes detected (empty install)" };
  }

  return { pkg, ok: true };
}

// ---------------------------------------------------------
// GITHUB INSTALL (with retries, asset selection, integrity)
// ---------------------------------------------------------
async function installFromGitHub(repoSpec) {
  const [repo, version = "latest"] = repoSpec.split("@");

  const release = await fetchRelease(repo, version);
  if (!release) return { pkg: repoSpec, ok: false, reason: "release not found" };

  const asset = selectAsset(release.assets);
  if (!asset) return { pkg: repoSpec, ok: false, reason: "no valid assets" };

  const file = path.join(os.tmpdir(), asset.name);

  const downloaded = await downloadWithRetry(asset.browser_download_url, file);
  if (!downloaded) return { pkg: repoSpec, ok: false, reason: "download failed" };

  if (!fileExistsNonZero(file)) {
    return { pkg: repoSpec, ok: false, reason: "file empty or missing" };
  }

  const verified = await verifySha256(repo, release.tag_name, file);
  if (!verified) return { pkg: repoSpec, ok: false, reason: "integrity failed" };

  return { pkg: repoSpec, ok: true };
}

// ---------------------------------------------------------
// FETCH RELEASE METADATA
// ---------------------------------------------------------
async function fetchRelease(repo, version) {
  const url =
    version === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${version}`;

  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// ASSET SELECTION LOGIC
// ---------------------------------------------------------
function selectAsset(assets = []) {
  if (!assets.length) return null;

  // Prefer tar.gz, then zip, then anything else
  const preferred = assets.find(a => a.name.endsWith(".tar.gz"))
    || assets.find(a => a.name.endsWith(".zip"))
    || assets[0];

  return preferred;
}

// ---------------------------------------------------------
// DOWNLOAD WITH RETRY + TIMEOUT
// ---------------------------------------------------------
async function downloadWithRetry(url, dest, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ok = await downloadFile(url, dest);
    if (ok) return true;
    await wait(500 * (i + 1));
  }
  return false;
}

async function downloadFile(url, dest) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return false;

    const file = fs.createWriteStream(dest);
    return new Promise(resolve => {
      res.body.pipe(file);
      res.body.on("end", () => resolve(true));
      res.body.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
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
    const actual = sha256(file);

    return expected === actual;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------
function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function fileExistsNonZero(file) {
  try {
    const stats = fs.statSync(file);
    return stats.size > 0;
  } catch {
    return false;
  }
}

function snapshotDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    return crypto
      .createHash("sha256")
      .update(files.join("|"))
      .digest("hex");
  } catch {
    return "missing";
  }
}

function runCommand(cmd) {
  return new Promise(resolve => {
    const child = spawn(...cmd, { stdio: "inherit" });
    child.on("close", code => resolve(code === 0));
  });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function banner(title, subtitle) {
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  🚀  ${title}`);
  console.log(`  → ${subtitle}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}

function summary(results) {
  console.log("");
  console.log("📦 INSTALL SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  for (const r of results) {
    if (r.ok) {
      console.log(`  ✔ ${r.pkg}`);
    } else {
      console.log(`  ✖ ${r.pkg} — ${r.reason}`);
    }
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}
