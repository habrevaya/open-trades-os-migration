import type { EntityName } from "../canonical/index.js";

/**
 * THE ADAPTER CONTRACT
 *
 * A source adapter does exactly one thing: turn someone else's API or CSV
 * export into canonical records. It never writes to OpenTradesOS, never
 * transforms business meaning, and never decides what a record should become.
 * That separation is what lets us add a platform in a day instead of a week.
 */

export interface ExtractContext {
  /** Where the raw snapshot is written. Resumable: check before you fetch. */
  snapshotDir: string;
  /**
   * Write raw records to the snapshot. Append-only, so a killed run leaves a
   * readable file rather than a truncated one.
   *
   * This is on the context rather than being a return value from `extract`
   * because an adapter that accumulated its results and handed them back would
   * hold an entire company's history in memory before a single byte reached
   * disk, and the shops with the most to migrate are exactly the ones where
   * that fails.
   */
  append(entity: EntityName, records: readonly unknown[]): Promise<void>;
  /** Called after each page so a killed run resumes instead of restarting. */
  checkpoint(entity: EntityName, cursor: string): Promise<void>;
  resume(entity: EntityName): Promise<string | undefined>;
  log(message: string): void;
}

export interface SourceCapabilities {
  /** Entities this adapter can pull at all. */
  entities: EntityName[];
  /** True when the source exposes an API. False means CSV export only. */
  hasApi: boolean;
  /** True when attachments can be fetched programmatically. */
  hasAttachments: boolean;
  /**
   * How the source models repeating work. This drives what the transform
   * stage has to reconstruct, and it is the single biggest source of
   * migration defects. See docs/recurring-schedules.md.
   */
  recurrenceModel: "rule" | "materialized-series" | "anchored-to-completion" | "manual-list" | "none";
  /**
   * Canonical entities this source does not store as their own records, and
   * the raw entity each is read out of instead.
   *
   * Some sources embed one thing inside another: addresses on the customer,
   * line items on the job. Declaring it here is what lets the transform stage
   * stay a general pipeline instead of growing a branch per source, which is
   * the exact coupling the adapter contract exists to prevent.
   *
   * Example: `{ property: "customer" }` means "read the customer file to
   * produce properties".
   */
  derivedFrom?: Partial<Record<EntityName, EntityName>>;

  /** Documented limits worth warning the operator about before they start. */
  knownLimits: string[];
}

export interface SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SourceCapabilities;

  /** Validate credentials before a long run. Fail in seconds, not an hour in. */
  verify(credentials: Record<string, string>): Promise<{ ok: boolean; account?: string; error?: string }>;

  /**
   * Pull everything into the raw snapshot. Rate limit aware, checkpointed.
   * Yields counts per entity so the CLI can show live progress.
   */
  extract(credentials: Record<string, string>, ctx: ExtractContext): AsyncGenerator<{
    entity: EntityName;
    count: number;
    done: boolean;
  }>;

  /** Map one raw snapshot record into canonical shape. Pure, and testable against fixtures. */
  toCanonical(entity: EntityName, raw: unknown): unknown;
}
