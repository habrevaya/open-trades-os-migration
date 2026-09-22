import type { SourceAdapter } from "./types.js";
import { jobber } from "./jobber/index.js";
import { housecallPro } from "./housecall-pro/index.js";

/**
 * Every adapter that exists, by id. The CLI resolves `--source` through here
 * and nowhere else, so an unimplemented source produces one honest message
 * rather than a stack trace from somewhere inside the extraction.
 */
export const adapters: SourceAdapter[] = [jobber, housecallPro];

export const PLANNED = ["workiz", "servicem8", "servicetitan", "fieldedge", "csv"] as const;

export function adapterFor(id: string): SourceAdapter {
  const found = adapters.find((a) => a.id === id);
  if (found) return found;
  if ((PLANNED as readonly string[]).includes(id)) {
    throw new Error(
      `The ${id} adapter is not written yet. Built today: ${adapters.map((a) => a.id).join(", ")}.`,
    );
  }
  throw new Error(
    `Unknown source "${id}". Available: ${[...adapters.map((a) => a.id), ...PLANNED].join(", ")}.`,
  );
}
