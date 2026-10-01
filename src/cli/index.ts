#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { readFile, writeFile } from "node:fs/promises";
import { adapterFor, adapters, PLANNED } from "../adapters/registry.js";
import { Snapshot } from "../snapshot/index.js";
import { transform, CountingSink } from "../transform/index.js";
import { renderProfile } from "../profile/index.js";
import { reconcile, renderReconcile, sourceSide, type Side } from "../reconcile/index.js";
import { buildMapping, check, mappingPath, readMapping, writeMapping, emptyMapping, type Mapping } from "../mapping/index.js";
import { load, renderLoad, failures } from "../load/index.js";
import { Ledger, defaultLedgerPath } from "../load/ledger.js";
import { HttpTarget, apiBase } from "../target/client.js";
import { MemoryTarget } from "../target/memory.js";
import { readTarget } from "../target/read.js";
import { fetchAttachments } from "../attachments/index.js";
import { defaultRetry } from "../adapters/http.js";

/**
 * Seven commands, each idempotent and resumable, each producing an artifact
 * the operator can inspect before the next one runs.
 *
 * The order is not a suggestion. `profile` exists so expectations are set
 * before anything moves, and `dryrun` exists so nobody discovers a mapping
 * mistake in production. Skipping them is how a migration becomes a horror
 * story someone posts about.
 *
 * All seven run. Where the target's API cannot take something the source
 * has, the commands say so by name rather than approximating it, because a
 * migration tool that half works quietly is worse than one that does not run.
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
function credentialsFor(source: string, options: { from?: string; columns?: string } = {}): Record<string, string> {
  // A spreadsheet export is reached by its path, not a token, and a path is
  // not a secret, so it is the one credential that is a flag.
  if (source === "csv") {
    if (!options.from) fail("The csv source reads a directory of exports. Pass --from <dir>.");
    return { dir: options.from, ...(options.columns ? { columns: options.columns } : {}) };
  }

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

/** The target's token. Same rule as the source's: the environment, never a flag. */
function targetToken(): string {
  const token = process.env["OPENTRADESOS_TOKEN"]?.trim();
  if (!token) {
    fail(
      `No target credential. Set OPENTRADESOS_TOKEN to a connected app token (ots_...).\n\n` +
        `  It needs write permission for customers, properties, the price book, jobs,\n` +
        `  visits, estimates, invoices and payments, and read permission for each of\n` +
        `  those for reconcile. See docs/loading.md.`,
    );
  }
  return token;
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
  .requiredOption("-s, --source <source>", "jobber | housecall-pro | csv | workiz | servicem8 | servicetitan | fieldedge")
  .option("-o, --out <dir>", "snapshot directory", "./snapshot")
  .option("--from <dir>", "csv only: the directory holding the exported files")
  .option("--columns <file>", "csv only: column mapping, if not <from>/columns.json")
  .action(async (options: { source: string; out: string; from?: string; columns?: string }) => {
    const adapter = resolve(options.source);
    const credentials = credentialsFor(adapter.id, options);

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
    const snapshot = await openSnapshot(options.in);
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

    await writeJson(options.json, result.profile);
    console.log("");

    const errors = result.profile.findings.filter((f) => f.severity === "error").length;
    if (errors > 0) {
      console.log(pc.yellow(`  ${errors} finding(s) at error severity. Resolve these before loading.\n`));
      process.exitCode = 1;
    }
  });

program
  .command("map")
  .description("Write the mapping file: technicians, job types, statuses and payment methods. Edit it, then run map again.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-m, --mapping <file>", "mapping file (default <in>/mapping.json)")
  .action(async (options: { in: string; mapping?: string }) => {
    const snapshot = await openSnapshot(options.in);
    const adapter = resolve(snapshot.source);
    const path = options.mapping ?? mappingPath(options.in);
    const existing = await readMapping(path).catch((error: Error) => fail(error.message));
    if (existing && existing.source !== snapshot.source) {
      fail(`${path} maps a ${existing.source} snapshot, not ${snapshot.source}.`);
    }

    const summary = await buildMapping(snapshot, adapter, existing);
    await writeMapping(path, summary.mapping);

    console.log("");
    console.log(`  ${existing ? "Updated" : "Wrote"} ${path}${summary.added.length > 0 ? ` (${summary.added.length} new value(s))` : ""}`);
    reportMapping(summary.mapping);
    console.log(`\n  Edit the file, run map again to check it, then:`);
    console.log(`  ${pc.cyan(`opentradesos-migrate dryrun --in ${options.in}`)}\n`);
  });

program
  .command("dryrun")
  .description("Load into a scratch tenant in memory and report every record that would fail, and why. Touches nothing real.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-m, --mapping <file>", "mapping file (default <in>/mapping.json)")
  .option("--carry-totals", "add lines for tax as applied and unitemised amounts, so invoice totals match the source")
  .option("--json <file>", "also write the full report as JSON")
  .action(async (options: { in: string; mapping?: string; carryTotals?: boolean; json?: string }) => {
    const snapshot = await openSnapshot(options.in);
    const adapter = resolve(snapshot.source);
    const path = options.mapping ?? mappingPath(options.in);
    let mapping = await readMapping(path).catch((error: Error) => fail(error.message));
    if (!mapping) {
      // A dry run is allowed to guess, because it writes nothing. It says so.
      console.log(pc.yellow(`\n  No mapping at ${path}. Using the toolkit's guesses; run map to review them.`));
      mapping = (await buildMapping(snapshot, adapter, emptyMapping(snapshot.source))).mapping;
    }
    refuseBadMapping(mapping, path);

    const target = new MemoryTarget();
    const ledger = Ledger.memory(target.description, snapshot.source, snapshot.info.account ?? "");
    const report = await load({
      snapshot, adapter, target, ledger, mapping, carryTotals: options.carryTotals ?? false, dryRun: true,
    });

    const expected = sourceSide(await transform(snapshot, adapter, new CountingSink()));
    const reading = await readTarget(target, ledger);
    const predicted = reconcile(expected, reading.side);

    console.log("");
    console.log(renderLoad(report));
    console.log("");
    console.log("PREDICTED RECONCILE, if this were loaded for real");
    console.log(renderReconcile(predicted).split("\n").map((l) => `  ${l}`).join("\n"));
    console.log("");
    await writeJson(options.json, { load: report, reconcile: predicted, notes: reading.notes });

    if (failures(report) > 0 || report.aborted) process.exitCode = 1;
  });

program
  .command("load")
  .description("Write into OpenTradesOS through its public API. Resumable, idempotent on source ids.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .requiredOption("-t, --target <url>", "the OpenTradesOS deployment, e.g. https://ots.example.com")
  .option("-m, --mapping <file>", "mapping file (default <in>/mapping.json)")
  .option("--ledger <file>", "load ledger (default <in>/load/<host>.ledger.ndjson)")
  .option("--carry-totals", "add lines for tax as applied and unitemised amounts, so invoice totals match the source")
  .option("--concurrency <n>", "records in flight at once", "4")
  .option("--json <file>", "also write the full report as JSON")
  .action(async (options: {
    in: string; target: string; mapping?: string; ledger?: string; carryTotals?: boolean; concurrency: string; json?: string;
  }) => {
    const token = targetToken();
    const snapshot = await openSnapshot(options.in);
    const adapter = resolve(snapshot.source);
    const path = options.mapping ?? mappingPath(options.in);
    const mapping = await readMapping(path).catch((error: Error) => fail(error.message));
    // Unlike dryrun, load does not guess. The guesses are in a file the
    // operator has had the chance to read, or the load does not start.
    if (!mapping) fail(`No mapping at ${path}. Run map, review the file, run dryrun, then load.`);
    refuseBadMapping(mapping, path);

    const base = apiBase(options.target);
    const ledger = await Ledger.open(options.ledger ?? defaultLedgerPath(options.in, base), base, snapshot.source, snapshot.info.account ?? "")
      .catch((error: Error) => fail(error.message));
    const retry = {
      ...defaultRetry(),
      onRetry: (info: { attempt: number; delayMs: number; reason: string }) => {
        process.stderr.write(`\n  ${pc.dim(`${info.reason}; retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt})`)}\n`);
      },
    };
    const target = new HttpTarget(base, token, { retry });

    const meter = progress();
    console.log(`\n  Loading into ${base}${ledger.size > 0 ? pc.dim(`, resuming from ${ledger.size} ledger entries`) : ""}`);
    const report = await load({
      snapshot, adapter, target, ledger, mapping,
      carryTotals: options.carryTotals ?? false,
      concurrency: Math.max(1, Number(options.concurrency) || 4),
      onProgress: meter.tick,
    });
    meter.finish();
    process.stdout.write("\n");
    console.log(renderLoad(report));
    await writeJson(options.json, report);
    console.log(`\n  Next: ${pc.cyan(`opentradesos-migrate reconcile --in ${options.in} --target ${options.target}`)}\n`);
    if (failures(report) > 0 || report.aborted) process.exitCode = 1;
  });

program
  .command("attachments")
  .description("Second pass for photos and documents. Downloads and indexes them locally; see docs/target-api-gaps.md.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-o, --out <dir>", "where files land (default <in>/attachments)")
  .option("-t, --target <url>", "index each file against the record load made in this target")
  .option("--ledger <file>", "load ledger (default <in>/load/<host>.ledger.ndjson)")
  .action(async (options: { in: string; out?: string; target?: string; ledger?: string }) => {
    const snapshot = await openSnapshot(options.in);
    const adapter = resolve(snapshot.source);
    if (!adapter.capabilities.hasAttachments) {
      console.log(pc.yellow(`\n  ${adapter.displayName} gives this toolkit no way to fetch attachments.`));
      for (const limit of adapter.capabilities.knownLimits.filter((l) => /attachment|photo/i.test(l))) {
        console.log(`  ${wrap(limit, 2)}`);
      }
      console.log("");
      return;
    }
    let ledger: Ledger | undefined;
    if (options.target) {
      const base = apiBase(options.target);
      ledger = await Ledger.open(options.ledger ?? defaultLedgerPath(options.in, base), base, snapshot.source, snapshot.info.account ?? "")
        .catch((error: Error) => fail(error.message));
    }
    const report = await fetchAttachments(snapshot, adapter, {
      ...(options.out ? { outDir: options.out } : {}),
      ...(ledger ? { ledger } : {}),
      onProgress: (n) => process.stdout.write(`\r  attachment ${String(n).padStart(8)}`),
    });
    process.stdout.write("\n\n");
    console.log(`  downloaded   ${String(report.downloaded).padStart(8)}  (${(report.bytes / 1_048_576).toFixed(1)} MB)`);
    console.log(`  already had  ${String(report.already).padStart(8)}`);
    if (report.empty > 0) console.log(`  no file      ${String(report.empty).padStart(8)}`);
    if (report.failed.length > 0) {
      console.log(`  failed       ${String(report.failed.length).padStart(8)}`);
      for (const f of report.failed.slice(0, 20)) console.log(`    ${f.sourceId}: ${f.reason}`);
      process.exitCode = 1;
    }
    console.log(`\n  Files and index.ndjson are in ${report.dir}.`);
    console.log(pc.yellow(`  They are NOT attached in OpenTradesOS: its API has no upload route a migration can use`));
    console.log(pc.yellow(`  (attachments.upload in docs/target-api-gaps.md). The index names each file's target record.\n`));
  });

program
  .command("reconcile")
  .description("Prove it. Record counts and dollar totals against the source, with a discrepancy report.")
  .option("-i, --in <dir>", "snapshot directory", "./snapshot")
  .option("-t, --target <url>", "read the totals back from this OpenTradesOS")
  .option("--ledger <file>", "load ledger (default <in>/load/<host>.ledger.ndjson)")
  .option("--against <file>", "or: a JSON summary of what the target reports")
  .option("--tolerance-cents <n>", "allowed drift, in cents. Default zero, and raising it is a decision", "0")
  .option("--json <file>", "also write the report as JSON")
  .action(async (options: {
    in: string; target?: string; ledger?: string; against?: string; toleranceCents: string; json?: string;
  }) => {
    if (!options.target === !options.against) fail("Pass exactly one of --target <url> or --against <file>.");
    const snapshot = await openSnapshot(options.in);
    const adapter = resolve(snapshot.source);
    const expected = sourceSide(await transform(snapshot, adapter, new CountingSink()));

    let actual: Side;
    let notes: string[] = [];
    if (options.target) {
      const base = apiBase(options.target);
      const ledger = await Ledger.open(options.ledger ?? defaultLedgerPath(options.in, base), base, snapshot.source, snapshot.info.account ?? "")
        .catch((error: Error) => fail(error.message));
      if (ledger.size === 0) fail(`The ledger for ${base} is empty. Nothing has been loaded there from this snapshot.`);
      const reading = await readTarget(new HttpTarget(base, targetToken()), ledger);
      actual = reading.side;
      notes = reading.notes;
    } else {
      actual = JSON.parse(await readFile(options.against!, "utf8")) as Side;
    }

    const report = reconcile(expected, actual, Number(options.toleranceCents) || 0);
    console.log("");
    console.log(renderReconcile(report));
    for (const note of notes) console.log(`\n  ${pc.dim(wrap(note, 2))}`);
    console.log("");
    await writeJson(options.json, { ...report, notes });
    if (!report.matched) process.exitCode = 1;
  });

async function openSnapshot(dir: string): Promise<Snapshot> {
  return Snapshot.read(dir).catch(() => fail(`No snapshot at ${dir}. Run extract first.`));
}

function reportMapping(mapping: Mapping): void {
  const result = check(mapping);
  const users = Object.keys(mapping.users).length;
  console.log(`  technicians  ${users - result.unmappedUsers.length} of ${users} mapped to a target user`);
  for (const id of result.unmappedUsers.slice(0, 15)) {
    console.log(`    ${pc.yellow("unmapped")}  ${id}  ${mapping.users[id]?.name ?? ""}`);
  }
  if (result.unmappedUsers.length > 15) console.log(`    ...and ${result.unmappedUsers.length - 15} more`);
  if (result.unmappedJobTypes.length > 0) {
    console.log(`  job types    ${result.unmappedJobTypes.length} with no target id: ${result.unmappedJobTypes.slice(0, 8).join(", ")}`);
  }
  if (result.undecidedJobStatuses.length > 0) {
    console.log(`  job status   ${pc.yellow("undecided")}: ${result.undecidedJobStatuses.join(", ")}`);
  }
  for (const bad of result.invalidTargets) console.log(`  ${pc.red("not valid")}    ${bad}`);
}

function refuseBadMapping(mapping: Mapping, path: string): void {
  const { invalidTargets } = check(mapping);
  if (invalidTargets.length > 0) {
    fail(`${path} has values the target will not accept:\n    ${invalidTargets.join("\n    ")}`);
  }
}

/** One line of progress, redrawn in place, so a long load shows it is alive without scrolling. */
function progress(): { tick: (entity: string, n: number) => void; finish: () => void } {
  let entity = "";
  let count = 0;
  let drawn = 0;
  const draw = () => { process.stdout.write(`\r  ${entity.padEnd(16)} ${String(count).padStart(8)}`); drawn = Date.now(); };
  // Finishing writes the entity's real total, not whichever count was last drawn.
  const finish = () => { if (entity !== "") { draw(); process.stdout.write("\n"); } entity = ""; };
  return {
    tick(current, n) {
      if (current !== entity) { finish(); entity = current; count = n; draw(); return; }
      count = n;
      if (Date.now() - drawn > 100) draw();
    },
    finish,
  };
}

async function writeJson(path: string | undefined, value: unknown): Promise<void> {
  if (!path) return;
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`  Report written to ${path}`);
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

program.parse();
