import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([".git", "node_modules", "dist", "coverage", ".vite-cache"]);
const skippedExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const checks = [
  { label: "private macOS home path", pattern: new RegExp("/" + "Users/") },
  { label: "private workspace identifier", pattern: new RegExp("BELNICK" + "-AI-AGENTS", "i") },
  { label: "tailnet hostname", pattern: new RegExp("\\.ts" + "\\.net", "i") },
  { label: "private key material", pattern: new RegExp("BEGIN (RSA |EC |OPENSSH )?PRIVATE " + "KEY") },
  { label: "GitHub token shape", pattern: new RegExp("gh[pousr]_[A-Za-z0-9]{20,}") },
  { label: "OpenAI token shape", pattern: new RegExp("sk-[A-Za-z0-9]{20,}") }
];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
    } else if (!skippedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

const findings = [];
const files = await filesUnder(root);
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const check of checks) {
    if (check.pattern.test(content)) {
      findings.push(`${path.relative(root, file)}: ${check.label}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`public safety scan ok: ${files.length} text files`);
}
