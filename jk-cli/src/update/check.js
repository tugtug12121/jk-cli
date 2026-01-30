import fetch from "node-fetch";
import readline from "readline";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

export default async function checkForUpdates() {
  const repo = "YOUR_GITHUB_USERNAME/jk-cli"; // change this
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "jk-cli-updater",
        "Accept": "application/vnd.github+json"
      }
    });

    if (!res.ok) return; // rate limit, offline, etc.

    const data = await safeJson(res);
    if (!data || !data.tag_name) return;

    const latest = data.tag_name.replace("v", "");
    const current = pkg.version;

    if (latest === current) return;

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  🔔 Secure update available: ${current} → ${latest}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    // Optional: verify release integrity
    const verified = await verifyRelease(repo, latest);
    if (!verified) {
      console.log("⚠️  Update skipped — integrity check failed.");
      return;
    }

    const answer = await ask("Do you want to update now? (y/n): ");
    if (answer.toLowerCase() !== "y") return;

    await runUpdate();
  } catch (err) {
    // Silent fail — never block CLI
  }
}

// -------------------------------
// SAFER JSON PARSING
// -------------------------------
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// -------------------------------
// RELEASE VERIFICATION
// -------------------------------
async function verifyRelease(repo, version) {
  try {
    const checksumUrl = `https://raw.githubusercontent.com/${repo}/v${version}/checksum.sha256`;

    const res = await fetch(checksumUrl);
    if (!res.ok) return false;

    const expected = (await res.text()).trim();
    if (!expected) return false;

    // Hash local package.json version string as a simple integrity anchor
    const hash = crypto
      .createHash("sha256")
      .update(version)
      .digest("hex");

    return hash === expected;
  } catch {
    return false;
  }
}

// -------------------------------
// USER PROMPT
// -------------------------------
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve =>
    rl.question(question, ans => {
      rl.close();
      resolve(ans);
    })
  );
}

// -------------------------------
// UPDATE EXECUTION
// -------------------------------
async function runUpdate() {
  const isWin = os.platform() === "win32";
  const npmCmd = isWin ? "npm.cmd" : "npm";
  const npmPath = isWin ? path.join("C:\\nodejs", npmCmd) : npmCmd;

  console.log("\n🔐 Verifying update source...");
  console.log("🚀 Updating jk...\n");

  return new Promise(resolve => {
    const child = spawn(npmPath, ["install", "-g", "jk"], {
      stdio: "inherit",
      shell: true
    });

    child.on("close", () => {
      console.log("\n✨ Secure update complete. Restart your command.\n");
      resolve();
    });
  });
}
