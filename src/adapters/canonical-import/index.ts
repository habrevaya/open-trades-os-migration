import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ENTITY_ORDER, SCHEMAS, type EntityName } from "../../canonical/index.js";
import type { ExtractContext, SourceAdapter, SourceCapabilities } from "../types.js";

/**
 * CANONICAL SNAPSHOT IMPORT
 *
 * For a source this toolkit does not connect to. The account owner produces
 * the records themselves, from their own account, already in the canonical
 * shape (src/canonical/index.ts; docs/snapshot-format.md), and this reads
 * them in. Nothing here holds a credential or calls anything: the input is a
 * directory of files.
 *
 * That is the whole of the ServiceTitan route (see docs/servicetitan.md and
 * the README), and it works the same for any source whose owner can produce
 * the files.
 *
 * The files are trusted for nothing. Every record is checked against the
 * canonical schema when it is read, and one that fails is reported by id
 * with the field that failed, exactly as an unreadable CSV row is, rather
 * than reaching the loader half formed.
 */

const BATCH = 500;

/** Entities with a schema, in dependency order: the files this importer reads. */
export const IMPORTABLE: EntityName[] = ENTITY_ORDER.filter((e) => SCHEMAS[e] !== undefined);

export interface CanonicalImportOptions {
  id: string;
  displayName: string;
  /** When set, every record must carry this `sourceSystem`. */
  sourceSystem?: string;
  capabilities?: Partial<SourceCapabilities>;
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** `<entity>.ndjson` (preferred, one record per line) or `<entity>.json` (an array). */
export async function fileFor(dir: string, entity: EntityName): Promise<{ path: string; format: "ndjson" | "json" } | undefined> {
  const ndjson = join(dir, `${entity}.ndjson`);
  if (await exists(ndjson)) return { path: ndjson, format: "ndjson" };
  const json = join(dir, `${entity}.json`);
  if (await exists(json)) return { path: json, format: "json" };
  return undefined;
}

/** Each record, or a marker for a line that is not JSON, so the report can name it. */
async function* recordsIn(file: { path: string; format: "ndjson" | "json" }): AsyncGenerator<Record<string, unknown>> {
  if (file.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file.path, "utf8"));
    } catch (error) {
      throw new Error(`${basename(file.path)} is not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${basename(file.path)} must hold a JSON array of records`);
    let n = 0;
    for (const record of parsed) {
      n += 1;
      yield record && typeof record === "object" && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : { _unreadable: `record ${n} is not an object` };
    }
    return;
  }
  const lines = createInterface({ input: createReadStream(file.path, "utf8"), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n += 1;
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      yield value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { _unreadable: `line ${n} is not an object` };
    } catch {
      yield { _unreadable: `line ${n} is not valid JSON` };
    }
  }
}

/** A schema failure as one line: the field paths and what was wrong with each. */
function describeIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(record)"}: ${i.message}`).join("; ") +
    (error.issues.length > 5 ? `; and ${error.issues.length - 5} more` : "");
}

export function createCanonicalImportAdapter(options: CanonicalImportOptions): SourceAdapter {
  const capabilities: SourceCapabilities = {
    entities: IMPORTABLE,
    hasApi: false,
    hasAttachments: true,
    recurrenceModel: "manual-list",
    knownLimits: [
      "Reads canonical records the account owner produced from their own account, one file per entity (docs/snapshot-format.md). Connects to nothing and holds no credential.",
      "Every record is checked against the canonical schema as it is read. One that fails is reported by id with the field that failed, and is not loaded.",
    ],
    ...options.capabilities,
  };

  return {
    id: options.id,
    displayName: options.displayName,
    capabilities,

    async verify(credentials) {
      const dir = credentials["dir"];
      if (!dir) return { ok: false, error: "No directory. Pass --from <dir>." };
      const customers = await fileFor(dir, "customer");
      if (!customers) {
        return { ok: false, error: `No customer.ndjson or customer.json in ${dir}. Every other file is optional; this one is not.` };
      }
      return { ok: true, account: credentials["account"] ?? basename(resolve(dir)) };
    },

    async *extract(credentials, ctx: ExtractContext) {
      const dir = credentials["dir"] ?? ".";
      for (const entity of IMPORTABLE) {
        const file = await fileFor(dir, entity);
        if (!file) { yield { entity, count: 0, done: true }; continue; }

        // Resuming skips what was already appended; re-reading a local file
        // is cheap, appending a record twice is a duplicate id in profile.
        const done = Number((await ctx.resume(entity)) ?? 0);
        let index = 0;
        let count = done;
        let batch: Record<string, unknown>[] = [];
        for await (const record of recordsIn(file)) {
          index += 1;
          if (index <= done) continue;
          // A relative attachment path means a file beside the export, and
          // nothing that reads the snapshot later knows where that was.
          if (entity === "attachment" && typeof record["localPath"] === "string" && !isAbsolute(record["localPath"])) {
            record["localPath"] = resolve(dir, record["localPath"]);
          }
          batch.push(record);
          if (batch.length >= BATCH) {
            await ctx.append(entity, batch);
            count += batch.length;
            batch = [];
            await ctx.checkpoint(entity, String(index));
            yield { entity, count, done: false };
          }
        }
        if (batch.length > 0) {
          await ctx.append(entity, batch);
          count += batch.length;
          await ctx.checkpoint(entity, String(index));
        }
        yield { entity, count, done: true };
      }
    },

    toCanonical(entity, raw) {
      const record = raw as Record<string, unknown>;
      if (typeof record["_unreadable"] === "string") throw new Error(record["_unreadable"]);
      const schema = SCHEMAS[entity];
      if (!schema) throw new Error(`${options.displayName} has no canonical mapping for "${entity}"`);
      const parsed = schema.safeParse(record);
      if (!parsed.success) throw new Error(describeIssues(parsed.error));
      // The file's own record is the payload unless it brought one: unknown
      // fields the schema strips are still the source's words.
      const value = { ...(parsed.data as Record<string, unknown>) };
      if (value["sourcePayload"] === undefined) value["sourcePayload"] = record;
      if (options.sourceSystem && value["sourceSystem"] !== options.sourceSystem) {
        throw new Error(
          `sourceSystem is ${JSON.stringify(value["sourceSystem"])}; every record in a ${options.displayName} import must say ${JSON.stringify(options.sourceSystem)}`,
        );
      }
      return value;
    },
  };
}

/** Any source, from canonical files. */
export const canonicalImport: SourceAdapter = createCanonicalImportAdapter({
  id: "canonical",
  displayName: "Canonical snapshot",
});
