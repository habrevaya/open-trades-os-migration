#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { readFile, writeFile } from "node:fs/promises";
import { adapterFor, adapters, PLANNED } from "../adapters/registry.js";
import { Snapshot } from "../snapshot/index.js";
import { transform, CountingSink } from "../transform/index.js";
import { renderProfile } from "../profile/index.js";
import { reconcile, renderReconcile, type Side } from "../reconcile/index.js";
import type { EntityName } from "../canonical/index.js";

/**
 * Seven commands, each idempotent and resumable, each producing an artifact
 * the operator can inspect before the next one runs.
 *
 * The order is not a suggestion. `profile` exists so expectations are set
 * before anything moves, and `dryrun` exists so nobody discovers a mapping
 * mistake in production. Skipping them is how a migration becomes a horror
 * story someone posts about.
 *
 * Three of the seven are implemented. The rest say so plainly rather than
 * doing something approximate, because a migration tool that half works is
 * worse than one that does not run.
 */
const program = new Command()
  .name("opentradesos-migrate")
  .description("Get your data out. Extract, profile, map, dry run, load, attachments, reconcile.")
  .version("0.1.0");

/**
 * Credentials come from the environment, never from a flag.
 *
 * A token passed as an argument lands in shell history and in the process
 * list, where every other user on the machine can read it. This is somebody's
 * live business account.
 */
function credentialsFor(source: string): Record<string, string> {
  const env = process.env;
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name];
      if (value && value.trim() !== "") return value.trim();
    }
    return undefined;
  };
  const token = source === "jobber"
    ? pick("JOBBER_TOKEN", "JOBBER_ACCESS_TOKEN")
    : pick("HOUSECALL_PRO_KEY", "HOUSECALL_PRO_TOKEN");

  if (!token) {
    const name = source === "jobber" ? "JOBBER_TOKEN" : "HOUSECALL_PRO_KEY";
    fail(
      `No credential found. Set ${name} in your environment.\n\n` +
        `  Deliberately not a command line flag: a token passed as an argument\n` +
        `  is written to your shell history and visible in the process list.`,
    );
  }
  return { token, key: token };
}

program
  .command("sources")
  .description("List the sources this build can read, and the ones it cannot yet.")
  .action(() => {
    console.log("");
    for (const adapter of adapters) {
      console.log(`  ${pc.green("ready")}    ${adapter.displayName.padEnd(18)} ${adapter.capabilities.entities.join(", ")}`);
      for (const limit of adapter.capabilities.knownLimits) {
        console.log(`           ${pc.dim(wrap(limit, 11))}`);
      }
      console.log("");
    }
    for (const planned of PLANNED) {
      console.log(`  ${pc.yellow("planned")}  ${planned}`);
    }
    console.log("");
  });

program
  .command("extract")
  .description("Pull everything from the source into a local raw snapshot. Never writes to OpenTradesOS.")
  .requiredOption("-s, --source <source>", "jobber | housecall-pro | workiz | servicem8 | servicetitan | fieldedge | csv")
  .option("-o, --out <dir>", "snapshot directory", "./snapshot")
  .action(async (options: { source: string; out: string }) => {
    const adapter = resolve(options.source);
    const credentials = credentialsFor(adapter.id);

    const check = await adapter.verify(credentials);
    if (!check.ok) fail(`Could not reach ${adapter.displayName}: ${check.error}`);
    console.log(`  ${pc.green("connected")}  ${adapter.displayName}${check.account ? ` (${check.account})` : ""}`);

    const snapshot = await Snapshot.open(options.out, adapter.id);
    if (check.account) snapshot.setAccount(check.account);

    // Resuming is the default rather than a flag. An extraction that dies at
    // 2am on the invoices should not re-pull nine thousand customers when the
    // operator retries it over coffee.
    const resumed = Object.keys(snapshot.info.checkpoints);
    if (resumed.length > 0) console.log(`  ${pc.dim(`resuming: ${resumed.join(", ")}`)}`);

    let last = "";
    for await (const progress of adapter.extract(credentials, snapshot)) {
      const line = `  ${progress.entity.padEnd(16)} ${String(progress.count).padStart(8)}${progress.done ? " done" : ""}`;
      if (line !== last) { process.stdout.write(`\r${line}`); last = line; }
      if (progress.done) { process.stdout.write("\n"); await snapshot.complete(progress.entity); }
    }
    await snapshot.flush();

    console.log(`\n  Snapshot written to ${options.out}`);
    console.log(`  Next: ${pc.cyan(`opentradesos-migrate profile --in ${options.out}`)}\n`);
  });

program
  .command("profile")
  .description("Report what was found: counts, date ranges, field fill rates, custom fields, anomalies.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("--json <file>", "also write the report as JSON")
  .action(async (options: { in: string; json?: string }) => {
    const snapshot = await Snapshot.read(options.in).catch(() => fail(`No snapshot at ${options.in}. Run extract first.`));
    const adapter = resolve(snapshot.source);

    const result = await transform(snapshot, adapter, new CountingSink());
    console.log("");
    console.log(renderProfile(result.profile));

    if (result.failures.length > 0) {
      console.log("");
      console.log(`UNREADABLE RECORDS (${result.failures.length})`);
      for (const failure of result.failures.slice(0, 10)) {
        console.log(`  ${failure.entity} ${failure.sourceId}: ${failure.error}`);
      }
      // These are not skipped quietly. Each one is a customer, a job or an
      // invoice that will not exist after the migration.
      console.log(`  ${pc.dim("Each of these is a record that will not migrate.")}`);
    }

    if (options.json) {
      await writeFile(options.json, JSON.stringify(result.profile, null, 2) + "\n", "utf8");
      console.log(`\n  Report written to ${options.json}`);
    }
    console.log("");

    const errors = result.profile.findings.filter((f) => f.severity === "error").length;
    if (errors > 0) {
      console.log(pc.yellow(`  ${errors} finding(s) at error severity. Resolve these before loading.\n`));
      process.exitCode = 1;
    }
  });

program
  .command("reconcile")
  .description("Prove it. Record counts and dollar totals against the source, with a discrepancy report.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .requiredOption("--against <file>", "JSON summary of what the target reports")
  .option("--tolerance-cents <n>", "allowed drift, in cents. Default zero, and raising it is a decision", "0")
  .action(async (options: { in: string; against: string; toleranceCents: string }) => {
    const snapshot = await Snapshot.read(options.in).catch(() => fail(`No snapshot at ${options.in}.`));
    const adapter = resolve(snapshot.source);
    const result = await transform(snapshot, adapter, new CountingSink());

    const expected: Side = {
      counts: result.counts as Partial<Record<EntityName, number>>,
      invoiceTotal: result.profile.totals.invoiceTotal,
      invoiceBalance: result.profile.totals.invoiceBalance,
      paymentTotal: result.profile.totals.paymentTotal,
      paymentAllocated: result.profile.totals.paymentAllocated,
    };
    const actual = JSON.parse(await readFile(options.against, "utf8")) as Side;

    const report = reconcile(expected, actual, Number(options.toleranceCents) || 0);
    console.log("");
    console.log(renderReconcile(report));
    console.log("");
    if (!report.matched) process.exitCode = 1;
  });

for (const [name, description] of [
  ["map", "Interactively map users, job types, tax codes and custom fields. Saves a reusable mapping."],
  ["dryrun", "Transform into a scratch tenant and produce a full diff and validation report. Touches nothing real."],
  ["load", "Write into OpenTradesOS. Batched, resumable, idempotent on source ids."],
  ["attachments", "Second pass for photos and documents. Slow, rate limited, separately resumable."],
] as const) {
  program.command(name).description(`${description} (not implemented yet)`)
    .allowUnknownOption(true)
    .action(() => notImplemented(name));
}

function resolve(source: string) {
  try {
    return adapterFor(source);
  } catch (error) {
    return fail((error as Error).message);
  }
}

function wrap(text: string, indent: number): string {
  const width = 78 - indent;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) { lines.push(line.trim()); line = word; }
    else line = `${line} ${word}`;
  }
  if (line.trim() !== "") lines.push(line.trim());
  return lines.join(`\n${" ".repeat(indent)}`);
}

function fail(message: string): never {
  console.error(`\n  ${pc.red(message)}\n`);
  process.exit(1);
}

function notImplemented(cmd: string): never {
  console.error(pc.yellow(`\n  ${cmd} is not implemented yet.\n`));
  console.error(`  Working today: ${pc.cyan("sources")}, ${pc.cyan("extract")}, ${pc.cyan("profile")}, ${pc.cyan("reconcile")}.`);
  console.error(`  Extract and profile are the two that answer "what do I actually have",`);
  console.error(`  and they run against a real account without writing anything anywhere.\n`);
  console.error(`  Roadmap and status: ${pc.cyan("https://github.com/habrevaya/open-trades-os-migration")}\n`);
  process.exit(1);
}

program.parse();
