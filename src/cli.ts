#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import "./detectors/index.js";
import { ImportError } from "./errors.js";
import { MIN_CORE_VERSION, TILTFILE_CORE } from "./flisk.js";
import { formatPlan } from "./format.js";
import { buildPlan } from "./plan.js";
import { applyTiltfileImport, formatTiltfilePlan, planTiltfileImport } from "./tiltfile.js";
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
  // Options after `tiltfile` belong to it, so `tiltfile --dry-run` is not read as the Compose import's --dry-run.
  .enablePositionalOptions()
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
        `Write ${pending.length} service.json file(s)${writes.projectConfig ? " and create .flisk/project.json" : ""}?`,
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
      `\nWrote ${written.length} service.json file(s)${writes.projectConfig ? " and created .flisk/project.json" : ""}.`,
    );
    const envFile = relative(process.cwd(), writes.env.path) || ".env";
    console.log("\nNext:");
    const copied = Object.keys(writes.env.add);
    if (copied.length)
      console.log(
        `  - Copied ${copied.length} environment value(s) from docker-compose.yml to ${envFile} (gitignored).`,
      );
    if (writes.env.tracked && copied.length)
      console.log(
        `  - ${writes.env.tracked} is tracked by git, so it was left as it is and not added to .gitignore; the values went to ${envFile}, which each service that needs them reads as envFile.`,
      );
    if (writes.items.some((item) => item.notes.some((note) => note.startsWith("no literal value"))))
      console.log(`  - Add the values listed above as missing to ${envFile}.`);
    console.log(
      `  - Run \`flisk up\` with Flisk core ${MIN_CORE_VERSION} or later. The import did not start anything.`,
    );
  });

program
  .command("tiltfile")
  .description(
    "Register an existing Tiltfile in .flisk/project.json so flisk up runs it unchanged (never edits the Tiltfile)",
  )
  .argument("[path]", "The Tiltfile, or a directory holding one", "Tiltfile")
  .option("--dry-run", "Print the plan and write nothing", false)
  .option("--yes", "Write without prompting", false)
  .option("--force", "Replace an orchestration already set in .flisk/project.json", false)
  .action(async (path: string, local) => {
    // Also honour the flags when they come before `tiltfile`, where the top-level command reads them.
    const top = program.opts();
    const options = {
      dryRun: local.dryRun || top.dryRun,
      yes: local.yes || top.yes,
      force: local.force || top.force,
    };
    const plan = planTiltfileImport(path, { force: options.force });

    console.log(formatTiltfilePlan(plan));
    if (options.dryRun) return void console.log("Dry run: nothing written.");
    const target =
      plan.action === "create" ? "Create .flisk/project.json" : "Update .flisk/project.json";
    if (
      !options.yes &&
      !(await confirm(`${target} with orchestration ${plan.orchestration.path}?`))
    ) {
      console.log("Nothing written.");
      process.exitCode = 2;
      return;
    }
    applyTiltfileImport(plan);
    console.log(`  wrote ${relative(process.cwd(), plan.projectJson) || ".flisk/project.json"}`);
    console.log(`\nRegistered ${plan.orchestration.path} as the orchestration source.`);
    console.log("\nNext:");
    console.log(
      `  - Run \`flisk up\` with a Flisk core that runs an imported Tiltfile (${TILTFILE_CORE}). It runs ${plan.orchestration.path} unchanged; the import did not start anything.`,
    );
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof ImportError) for (const s of err.suggestions) console.error(`  -> ${s}`);
  process.exit(err instanceof ImportError && err.exitCode ? err.exitCode : 1);
}
