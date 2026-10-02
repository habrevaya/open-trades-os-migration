import type { SourceAdapter } from "./types.js";
import { jobber } from "./jobber/index.js";
import { housecallPro } from "./housecall-pro/index.js";
import { csv } from "./csv/index.js";
import { workiz } from "./workiz/index.js";
import { fieldedge } from "./fieldedge/index.js";
import { servicetitan } from "./servicetitan/index.js";
import { servicetitanReports } from "./servicetitan/reports.js";
import { canonicalImport } from "./canonical-import/index.js";

/**
 * Every adapter that exists, by id. The CLI resolves `--source` through here
 * and nowhere else, so an unimplemented source produces one honest message
 * rather than a stack trace from somewhere inside the extraction.
 */
export const adapters: SourceAdapter[] = [jobber, housecallPro, workiz, fieldedge, servicetitanReports, servicetitan, csv, canonicalImport];

/** Sources with no adapter yet, and nothing in the way of writing one. */
export const PLANNED: readonly string[] = [];

/**
 * Sources this toolkit will not read through their API, and why. The line
 * in the README is that every adapter runs on credentials or exports the
 * owner provides for their own account, with no way around any platform's
 * terms; where a platform's terms rule out the API route, it is said here
 * by name instead of being built.
 */
export const BLOCKED: Readonly<Record<string, string>> = {
  servicem8:
    "ServiceM8 is read from your own CSV exports, with --source csv: that is the route, not a stopgap. " +
    "Its platform policy does not allow its API to be used to export data to a product that replicates " +
    "ServiceM8 without ServiceM8's permission, so this toolkit does not connect to ServiceM8's API. See docs/servicem8.md.",
};

export function adapterFor(id: string): SourceAdapter {
  const found = adapters.find((a) => a.id === id);
  if (found) return found;
  const blocked = BLOCKED[id];
  if (blocked) throw new Error(blocked);
  if (PLANNED.includes(id)) {
    throw new Error(
      `The ${id} adapter is not written yet. Built today: ${adapters.map((a) => a.id).join(", ")}.`,
    );
  }
  throw new Error(
    `Unknown source "${id}". Available: ${[...adapters.map((a) => a.id), ...PLANNED].join(", ")}.`,
  );
}
