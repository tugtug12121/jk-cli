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
  if (!pkgs.length) {
    return console.log("jk: install requires at least one package name");
  }

  banner("jk secure installer", `Installing: ${pkgs.join(", ")}`);

  const results = [];

  for (const raw of pkgs) {
    const pkg = raw.trim();
    if (!pkg) {
      results.push({ pkg: raw, ok: false, reason: "empty package name" });
      continue;
    }

    try {
      const type = await detectPackageType(pkg);

      switch (type) {
        case "npm":
          results.push(await installFromNpm(stripPrefix(pkg, "npm:")));
          break;

        case "github":
          results.push(await installFromGitHub(stripPrefix(pkg, "github:")));
          break;

        case "pip":
          results.push(await installFromPip(stripPrefix(pkg, "pip:")));
          break;

        case "cargo":
          results.push(await installFromCargo(stripPrefix(pkg, "cargo:")));
          break;

        case "go":
          results.push(await installFromGo(stripPrefix(pkg, "go:")));
          break;

        case "brew":
          results.push(await installFromBrew(stripPrefix(pkg, "brew:")));
          break;

        case "system":
          results.push({ pkg, ok: false, reason: "system tool — cannot be installed via jk" });
          break;

        default:
          results.push({ pkg, ok: false, reason: "unknown or invalid package" });
      }
    } catch (err) {
      results.push({ pkg, ok: false, reason: `fatal: ${err.message}` });
    }
  }

  summary(results);
}

// ---------------------------------------------------------
// PACKAGE TYPE DETECTION (strict, multi-ecosystem)
// ---------------------------------------------------------
async function detectPackageType(pkg) {
  const clean = pkg.trim();

  if (!clean || clean.length < 2) return "invalid";

  const systemTools = ["git", "python", "node", "cargo", "go", "pip", "pnpm", "bun"];
  if (systemTools.includes(clean.toLowerCase())) return "system";

  if (clean.startsWith("npm:")) return "npm";
  if (clean.startsWith("github:")) return "github";
  if (clean.startsWith("pip:")) return "pip";
  if (clean.startsWith("cargo:")) return "cargo";
  if (clean.startsWith("go:")) return "go";
  if (clean.startsWith("brew:")) return "brew";

  if (clean.includes("/")) {
    const gh = await safeFetch(`https://api.github.com/repos/${clean}`, 5000);
    if (gh?.ok) return "github";
  }

  const npm = await safeFetch(`https://registry.npmjs.org/${clean}`, 5000);
  if (npm?.ok) return "npm";

  return "invalid";
}

// ---------------------------------------------------------
// NPM INSTALL (strict verification)
// ---------------------------------------------------------
async function installFromNpm(pkg) {
  const isWin = os.platform() === "win32";
  const cmd = isWin
    ? ["cmd.exe", ["/c", "npm", "install", pkg]]
    : ["npm", ["install", pkg]];

  const before = snapshotDir("node_modules");
  const ok = await runCommand(cmd);

  if (!ok) return { pkg, ok: false, reason: "npm exited with non-zero code" };

  const after = snapshotDir("node_modules");
  if (before === after) {
    return { pkg, ok: false, reason: "no changes detected in node_modules" };
  }

  return { pkg, ok: true };
}

// ---------------------------------------------------------
// GITHUB INSTALL (strict: requires checksum)
// ---------------------------------------------------------
async function installFromGitHub(spec) {
  const [repo, version = "latest"] = spec.split("@");

  const release = await fetchRelease(repo, version);
  if (!release) return { pkg: spec, ok: false, reason: "release not found" };

  if (!Array.isArray(release.assets) || release.assets.length === 0) {
    return { pkg: spec, ok: false, reason: "no assets in release" };
  }

  const asset = selectAsset(release.assets);
  if (!asset) return { pkg: spec, ok: false, reason: "no supported asset types" };

  const file = path.join(os.tmpdir(), asset.name);

  const downloaded = await downloadWithRetry(asset.browser_download_url, file);
  if (!downloaded) return { pkg: spec, ok: false, reason: "download failed" };

  if (!fileExistsNonZero(file)) {
    return { pkg: spec, ok: false, reason: "downloaded file empty or missing" };
  }

  const verified = await verifySha256(repo, release.tag_name, file);
  if (!verified) {
    return { pkg: spec, ok: false, reason: "integrity failed (checksum required)" };
  }

  return { pkg: spec, ok: true };
}

// ---------------------------------------------------------
// PYTHON (pip)
// ---------------------------------------------------------
async function installFromPip(pkg) {
  return runCommand(["pip", ["install", pkg]])
    .then(ok => ok
      ? { pkg, ok: true }
      : { pkg, ok: false, reason: "pip install failed" }
    );
}

// ---------------------------------------------------------
// RUST (cargo)
// ---------------------------------------------------------
async function installFromCargo(pkg) {
  return runCommand(["cargo", ["install", pkg]])
    .then(ok => ok
      ? { pkg, ok: true }
      : { pkg, ok: false, reason: "cargo install failed" }
    );
}

// ---------------------------------------------------------
// GO
// ---------------------------------------------------------
async function installFromGo(pkg) {
  return runCommand(["go", ["install", pkg]])
    .then(ok => ok
      ? { pkg, ok: true }
      : { pkg, ok: false, reason: "go install failed" }
    );
}

// ---------------------------------------------------------
// HOMEBREW
// ---------------------------------------------------------
async function installFromBrew(pkg) {
  return runCommand(["brew", ["install", pkg]])
    .then(ok => ok
      ? { pkg, ok: true }
      : { pkg, ok: false, reason: "brew install failed" }
    );
}

// ---------------------------------------------------------
// FETCH RELEASE METADATA
// ---------------------------------------------------------
async function fetchRelease(repo, version) {
  const url =
    version === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${version}`;

  const res = await safeFetch(url, 8000);
  if (!res?.ok) return null;

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// ASSET SELECTION LOGIC
// ---------------------------------------------------------
function selectAsset(assets = []) {
  return (
    assets.find(a => a.name.endsWith(".tar.gz")) ||
    assets.find(a => a.name.endsWith(".zip")) ||
    null
  );
}

// ---------------------------------------------------------
// DOWNLOAD WITH RETRY
// ---------------------------------------------------------
async function downloadWithRetry(url, dest, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const ok = await downloadFile(url, dest);
    if (ok) return true;
    await wait(500 * (i + 1));
  }
  return false;
}

async function downloadFile(url, dest) {
  try {
    const res = await safeFetch(url, 10000);
    if (!res?.ok || !res.body) return false;

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
// SAFE FETCH
// ---------------------------------------------------------
async function safeFetch(url, timeoutMs) {
  try {
    return await fetch(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "jk-installer" }
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// SHA256 VERIFICATION
// ---------------------------------------------------------
async function verifySha256(repo, version, file) {
  const checksumUrl = `https://raw.githubusercontent.com/${repo}/${version}/checksum.sha256`;

  const res = await safeFetch(checksumUrl, 5000);
  if (!res?.ok) return false;

  let expected;
  try {
    expected = (await res.text()).trim();
  } catch {
    return false;
  }

  if (!expected || expected.length < 32) return false;

  const actual = sha256(file);
  return expected === actual;
}

// ---------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileExistsNonZero(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function snapshotDir(dir) {
  try {
    const files = fs.readdirSync(dir).sort();
    return crypto.createHash("sha256").update(files.join("|")).digest("hex");
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

function stripPrefix(str, prefix) {
  return str.startsWith(prefix) ? str.slice(prefix.length) : str;
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
    if (r.ok) console.log(`  ✔ ${r.pkg}`);
    else console.log(`  ✖ ${r.pkg} — ${r.reason}`);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}
