#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import "./detectors/index.js";
import { ImportError } from "./errors.js";
import { formatPlan } from "./format.js";
import { buildPlan } from "./plan.js";
import { MIN_CORE_VERSION } from "./tdk.js";
import { applyWrites, manifestRelPath, planWrites } from "./write.js";

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    const answer = await Promise.race([rl.question(`${message} (Y/n) `), closed]);
    if (answer === null) return false;
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

const program = new Command("flisk-import")
  .version(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
  .description("Import services from the root docker-compose.yml into Flisk")
  .argument("[dir]", "Directory containing docker-compose.yml", ".")
  .option("--dry-run", "Print the plan and write nothing", false)
  .option("--yes", "Write without prompting", false)
  .option("--force", "Overwrite an existing service.json", false)
  .action(async (dir: string, options) => {
    const plan = buildPlan(dir);
    const writes = planWrites(plan, options.force);

    console.log(formatPlan(plan, writes));

    const pending = writes.items.filter((i) => i.status !== "exists");
    if (plan.services.length === 0) {
      console.log("Nothing to import: no service in docker-compose.yml could be mapped.");
      process.exitCode = 1;
      return;
    }
    if (options.dryRun) return void console.log("Dry run: nothing written.");
    if (pending.length === 0 && !writes.projectConfig) {
      return void console.log("Nothing to write: every service.json already exists.");
    }
    if (
      !options.yes &&
      !(await confirm(
        `Write ${pending.length} service.json file(s)${writes.projectConfig ? " and create .tdk/project.json" : ""}?`,
      ))
    ) {
      console.log("Nothing written.");
      process.exitCode = 2;
      return;
    }
    const written = applyWrites(writes);
    for (const item of written) {
      console.log(`  wrote ${relative(process.cwd(), item.path) || manifestRelPath(plan, item)}`);
    }
    console.log(
      `\nWrote ${written.length} service.json file(s)${writes.projectConfig ? " and created .tdk/project.json" : ""}.`,
    );
    const envFile = relative(process.cwd(), join(writes.projectRoot, ".env")) || ".env";
    console.log("\nNext:");
    if (plan.services.some((s) => s.envKeys.length))
      console.log(
        `  - Put the environment values these services need in ${envFile}; values in docker-compose.yml were not copied.`,
      );
    console.log(
      `  - Run \`flisk up\` with Flisk core ${MIN_CORE_VERSION} or later. The import did not start anything.`,
    );
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof ImportError) for (const s of err.suggestions) console.error(`  -> ${s}`);
  process.exit(err instanceof ImportError && err.exitCode ? err.exitCode : 1);
}
