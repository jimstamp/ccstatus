#!/usr/bin/env node

import { readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const claudeDir = join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const scriptSrc = join(__dirname, "statusline.sh");
const scriptDest = join(claudeDir, "statusline.sh");

console.log("Installing ccstatus — Claude Code context-reflective statusline\n");

// Ensure ~/.claude exists
mkdirSync(claudeDir, { recursive: true });

// Copy statusline.sh
copyFileSync(scriptSrc, scriptDest);
chmodSync(scriptDest, 0o755);
console.log(`  ✓ Copied statusline.sh → ${scriptDest}`);

// Wire into settings.json
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    console.error(`  ✗ Failed to parse ${settingsPath} — backing up and creating fresh`);
    copyFileSync(settingsPath, settingsPath + ".bak");
    settings = {};
  }
}

const statusLineConfig = {
  type: "command",
  command: "~/.claude/statusline.sh",
  padding: 2,
};

if (JSON.stringify(settings.statusLine) === JSON.stringify(statusLineConfig)) {
  console.log("  ✓ settings.json already configured");
} else {
  if (settings.statusLine) {
    console.log(`  ⚠ Replacing existing statusLine config in settings.json`);
  }
  settings.statusLine = statusLineConfig;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  ✓ Updated ${settingsPath}`);
}

// Check dependencies
const checks = [
  { cmd: "jq", note: "required — statusline parses JSON input" },
  { cmd: "gh", note: "required — GitHub org membership detection" },
  { cmd: "claude", note: "required — auth status detection" },
];

console.log("\n  Dependency check:");
for (const { cmd, note } of checks) {
  try {
    const { execSync } = await import("child_process");
    execSync(`which ${cmd}`, { stdio: "ignore" });
    console.log(`    ✓ ${cmd} — found`);
  } catch {
    console.log(`    ✗ ${cmd} — not found (${note})`);
  }
}

console.log("\n  Done. The statusline will appear after your next Claude Code interaction.");
console.log("  Optional env vars:");
console.log("    BLUEPRINT_PATH=/path/to/blueprint/data  — enables engagement context");
