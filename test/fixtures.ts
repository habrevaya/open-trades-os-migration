import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function load<T = Record<string, unknown>>(source: string, name: string): T[] {
  return JSON.parse(readFileSync(join(root, source, `${name}.json`), "utf8")) as T[];
}

export function byId<T extends Record<string, unknown>>(records: T[], id: string): T {
  const found = records.find((r) => r["id"] === id);
  if (!found) throw new Error(`Fixture has no record with id ${id}`);
  return found;
}
