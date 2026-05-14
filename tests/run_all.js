const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const testsDir = __dirname;
const testFiles = fs
  .readdirSync(testsDir)
  .filter((file) => file.startsWith("test_") && file.endsWith(".js"));

let passed = 0;
let failed = 0;

for (const file of testFiles) {
  const filePath = path.join(testsDir, file);
  try {
    execSync(`node "${filePath}"`, { stdio: "inherit" });
    passed++;
  } catch {
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
