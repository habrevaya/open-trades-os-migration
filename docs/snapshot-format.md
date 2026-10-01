# Canonical snapshot format

What the `servicetitan` and `canonical` sources read: a directory of files,
one per entity, holding records already in this toolkit's canonical shape.
It is for a source this toolkit does not connect to, where the account owner
produces the records from their own account and hands over the files.

```
npx @opentradesos/migrate extract --source canonical --from ./my-export --out ./snapshot
```

The schemas are the zod definitions in
[`src/canonical/index.ts`](../src/canonical/index.ts), which are the
authority; this page is a guide to them.

## Files

One file per entity, named for the entity, either NDJSON (one JSON object
per line, preferred: it streams) or a JSON array:

```
customer.ndjson          required
property.ndjson          contact.ndjson           equipment.ndjson
priceBookItem.ndjson     estimate.ndjson          job.ndjson
recurringSchedule.ndjson invoice.ndjson           payment.ndjson
user.ndjson              attachment.ndjson
```

(or the same names ending `.json`). Any file but `customer` may be left out.

## Every record

| Field | |
|---|---|
| `sourceSystem` | The system the record came from. The `servicetitan` source requires `"servicetitan"` on every record |
| `sourceId` | Its id in that system. Stable: the load is idempotent on it, and a re-export must give the same record the same id |
| `sourcePayload` | Optional. The record as the source held it. If absent, the whole line is kept instead |

References between records use the other record's `sourceId`:
`customerSourceId`, `propertySourceId`, `jobSourceId`, `invoiceSourceId`,
`technicianSourceIds` (users), `equipmentSourceIds`, `jobSourceIds`.

## Values

- **Money** is a **string**, a decimal with at most four places: `"344.24"`,
  `"-120.00"`, `"26.235"`. A JSON number is refused, because a float has
  already lost the cent by the time it is written.
- **Dates** are ISO 8601: `"2024-03-14"`, or a timestamp with its offset,
  `"2024-03-14T15:41:00Z"`.
- **Quantities** are money-shaped strings too: `"1"`, `"2.5"`.
- Fields with defaults (`tags`, `customFields`, `lines`, `country`...) may
  be left out.

## Entities, briefly

| Entity | Required | Notes |
|---|---|---|
| customer | sourceId, name | `type` residential or commercial; `billingAddress` {line1, line2, city, state, postalCode, country} |
| property | customerSourceIds (array), addressLine1, city, state, postalCode | One property, many customers, is one record with several ids |
| contact | customerSourceId, name | role as the source names it; `isPrimary` |
| equipment | propertySourceId, category | manufacturer, model, serialNumber, installedOn, warrantyPartsExpiresOn, warrantyLaborExpiresOn, attributes |
| priceBookItem | name | `kind`: service, material, equipment, labor, fee, discount; price is today's price |
| job | customerSourceId, propertySourceId, status, summary | `visits`: [{sourceId, status, windowStart, windowEnd, completedAt, technicianSourceIds}] |
| recurringSchedule | customerSourceId, model, name, status | `model`: rule, materialized-series, anchored-to-completion, manual-list. See [recurring-schedules.md](recurring-schedules.md). Carry `anchorOn` and `nextOccurrenceOn` |
| estimate | customerSourceId, status | `options`: [{name, lines}] |
| invoice | customerSourceId, status | total, balance, subtotal, taxTotal; `lines` with `taxRate` and `taxAmount` as applied |
| payment | customerSourceId, method, status, amount, receivedAt | `allocations`: [{invoiceSourceId, amount}]. None means unapplied money |
| user | name | People who did work; mapped to target users during `map`, never created |
| attachment | entityType, entitySourceId | `downloadUrl`, or `localPath` relative to the export directory |

## Checking

Every record is validated against its schema as it is read. One that fails
is reported by `profile` and `dryrun` by id, with the field that failed:

```
invoice I1: total: Expected string, received number
```

It is not loaded. Run `profile` until there are none.
