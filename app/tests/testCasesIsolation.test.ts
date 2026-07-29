import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const isolatedRoot = mkdtempSync(join(tmpdir(), "spelling-coach-tests-"));
const isolatedReferenceData = join(isolatedRoot, "reference_data");

cpSync(join(projectRoot, "reference_data"), isolatedReferenceData, {
  recursive: true,
});

// Mutable repositories always start empty and exist only inside this process's sandbox.
writeFileSync(join(isolatedReferenceData, "words.custom.generated.json"), "[]\n", "utf8");
writeFileSync(join(isolatedReferenceData, "words.foreign.generated.json"), "[]\n", "utf8");

process.chdir(isolatedRoot);

await import("../testCases.js");

test.after(() => {
  process.chdir(projectRoot);
  rmSync(isolatedRoot, { recursive: true, force: true });
});
