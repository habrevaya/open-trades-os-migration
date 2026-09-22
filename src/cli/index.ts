#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";

/**
 * Seven commands, each idempotent and resumable, each producing an artifact
 * the operator can inspect before the next one runs.
 *
 * The order is not a suggestion. `profile` exists so expectations are set
 * before anything moves, and `dryrun` exists so nobody discovers a mapping
 * mistake in production. Skipping them is how a migration becomes a horror
 * story someone posts about.
 */
const program = new Command()
  .name("opentradesos-migrate")
  .description("Get your data out. Extract, profile, map, dry run, load, attachments, reconcile.")
  .version("0.0.0");

program
  .command("extract")
  .description("Pull everything from the source into a local raw snapshot. Never writes to OpenTradesOS.")
  .requiredOption("-s, --source <source>", "jobber | housecall-pro | workiz | servicem8 | servicetitan | fieldedge | csv")
  .option("-o, --out <dir>", "snapshot directory", "./snapshot")
  .option("--resume", "continue a previous run from its checkpoints", false)
  .action(() => notImplemented("extract"));

program
  .command("profile")
  .description("Report what was found: counts, date ranges, field fill rates, custom fields, anomalies.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .action(() => notImplemented("profile"));

program
  .command("map")
  .description("Interactively map users, job types, tax codes and custom fields. Saves a reusable mapping.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-m, --mapping <file>", "mapping file", "./mapping.json")
  .action(() => notImplemented("map"));

program
  .command("dryrun")
  .description("Transform into a scratch tenant and produce a full diff and validation report. Touches nothing real.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-m, --mapping <file>", "mapping file", "./mapping.json")
  .action(() => notImplemented("dryrun"));

program
  .command("load")
  .description("Write into OpenTradesOS. Batched, resumable, idempotent on source ids.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-m, --mapping <file>", "mapping file", "./mapping.json")
  .requiredOption("--target <url>", "OpenTradesOS API base URL")
  .action(() => notImplemented("load"));

program
  .command("attachments")
  .description("Second pass for photos and documents. Slow, rate limited, separately resumable.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .requiredOption("--target <url>", "OpenTradesOS API base URL")
  .action(() => notImplemented("attachments"));

program
  .command("reconcile")
  .description("Prove it. Record counts and dollar totals against the source, with a discrepancy report.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .requiredOption("--target <url>", "OpenTradesOS API base URL")
  .action(() => notImplemented("reconcile"));

function notImplemented(cmd: string): never {
  console.error(pc.yellow(`\n  ${cmd} is not implemented yet.\n`));
  console.error(`  This toolkit is Phase 0. The canonical model and the adapter`);
  console.error(`  contract are defined; the adapters are not written yet.\n`);
  console.error(`  Roadmap and status: ${pc.cyan("https://github.com/habrevaya/open-trades-os-migration")}\n`);
  process.exit(1);
}

program.parse();
