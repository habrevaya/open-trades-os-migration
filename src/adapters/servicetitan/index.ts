/**
 * SERVICETITAN, ADVANCED: A CANONICAL SNAPSHOT YOU PRODUCED
 *
 * The default ServiceTitan route is the owner's own report exports, read by
 * `servicetitan-csv` (./reports.ts, docs/servicetitan.md). This is the other
 * one, for an owner who has produced a canonical snapshot of their own
 * tenant by whatever means their own agreement with ServiceTitan provides.
 * Either way this toolkit connects to nothing: we never hold ServiceTitan
 * credentials and never call its API, and nothing in this repository does.
 *
 * `extract --source servicetitan` picks between the two by what is in the
 * folder (a customer.ndjson means a snapshot), or by `--format`.
 *
 * Every record is required to say `sourceSystem: "servicetitan"` so a
 * ServiceTitan snapshot cannot be mixed with another source's. The file
 * format is docs/snapshot-format.md.
 */
import { createCanonicalImportAdapter } from "../canonical-import/index.js";
import type { SourceAdapter } from "../types.js";

export const servicetitan: SourceAdapter = createCanonicalImportAdapter({
  id: "servicetitan",
  displayName: "ServiceTitan",
  sourceSystem: "servicetitan",
  capabilities: {
    knownLimits: [
      "Advanced. Most owners want the report exports instead (ServiceTitan (reports), --format reports). This imports a canonical snapshot you produced from your own tenant; see docs/servicetitan.md.",
      "This toolkit never connects to ServiceTitan and never holds ServiceTitan credentials.",
      "Reads canonical records, one file per entity (docs/snapshot-format.md), each with sourceSystem \"servicetitan\". Records naming any other source are refused.",
      "Every record is checked against the canonical schema as it is read. One that fails is reported by id with the field that failed, and is not loaded.",
      "What arrives is exactly what you produced. Each recurring schedule states its own recurrence model; nothing is inferred from repeating jobs.",
    ],
  },
});
