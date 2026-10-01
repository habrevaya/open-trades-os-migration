/**
 * SERVICETITAN
 *
 * Not an adapter in the sense the others are, on purpose. As the README
 * says: for ServiceTitan this toolkit connects to nothing. The account owner
 * produces a snapshot of their own tenant, by whatever means their own
 * agreement with ServiceTitan provides, and this imports the files they
 * produced. We never hold ServiceTitan credentials and never call its API,
 * and nothing in this repository does.
 *
 * So this is the canonical snapshot importer, with every record required to
 * say `sourceSystem: "servicetitan"` so a ServiceTitan snapshot cannot be
 * mixed with another source's. The file format is docs/snapshot-format.md;
 * the route is docs/servicetitan.md.
 */
import { createCanonicalImportAdapter } from "../canonical-import/index.js";
import type { SourceAdapter } from "../types.js";

export const servicetitan: SourceAdapter = createCanonicalImportAdapter({
  id: "servicetitan",
  displayName: "ServiceTitan",
  sourceSystem: "servicetitan",
  capabilities: {
    knownLimits: [
      "This toolkit never connects to ServiceTitan and never holds ServiceTitan credentials. You produce the snapshot from your own tenant and this imports it; see docs/servicetitan.md.",
      "Reads canonical records, one file per entity (docs/snapshot-format.md), each with sourceSystem \"servicetitan\". Records naming any other source are refused.",
      "Every record is checked against the canonical schema as it is read. One that fails is reported by id with the field that failed, and is not loaded.",
      "What arrives is exactly what you produced. Each recurring schedule states its own recurrence model; nothing is inferred from repeating jobs.",
    ],
  },
});
