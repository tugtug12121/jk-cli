#!/usr/bin/env node
import checkForUpdates from "./update/check.js";

await checkForUpdates();

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

switch (command) {
  case "install":
    await import("./commands/install.js").then(m => m.default(rest));
    break;

  case "create":
    await import("./commands/create.js").then(m => m.default(rest));
    break;

  case "dev":
    await import("./commands/dev.js").then(m => m.default(rest));
    break;

  default:
    console.log("jk: unknown command");
    console.log("Available: install, create, dev");
}
