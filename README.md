# open-trades-os-migration

**Get your data out.** A migration toolkit for moving off Jobber, ServiceTitan,
Housecall Pro, Workiz, ServiceM8, FieldEdge and the rest, into
[OpenTradesOS](https://github.com/habrevaya/open-trades-os) or anywhere else.

Apache 2.0 on purpose. Use it, fork it, sell services around it. Getting your
own data out of software you pay for should not require anyone's permission.

## Why this is a separate repo

Because the hardest part of leaving field service software is not the software.
It is ten years of customer history, equipment serial numbers, warranty dates,
recurring maintenance schedules and open receivables sitting in someone else's
database.

Of the ten major platforms we surveyed, **not one publishes a documented bulk
export endpoint.** That friction is not an oversight. It is the retention
strategy.

## Status

**Phase 0.** The canonical model and the adapter contract are defined. No
adapter is written yet. `npx @opentradesos/migrate extract` will tell you so.

| Source | Route | Status |
|---|---|---|
| Jobber | GraphQL, OAuth | Planned, first |
| Housecall Pro | REST, OAuth or API key | Planned |
| Workiz | REST, API key | Planned |
| ServiceM8 | REST, OAuth | Planned |
| ServiceTitan | REST v2, OAuth plus app key | Planned |
| FieldEdge | CSV export only | Planned |
| Generic CSV | Mapped CSV | Planned |

## How it works

Seven commands, each idempotent and resumable, each producing an artifact you
can inspect before the next one runs.

```
extract      Pull into a local raw snapshot. Never writes to the target
profile      Report counts, date ranges, fill rates, custom fields, anomalies
map          Map users, job types, tax codes and custom fields. Saved, reusable
dryrun       Full transform into a scratch tenant, with a diff. Touches nothing
load         Batched, resumable, idempotent on source ids
attachments  Second pass for photos and documents. Slow and rate limited
reconcile    Prove it. Counts and dollar totals, with a discrepancy report
```

`profile` exists so expectations are set before anything moves. `dryrun` exists
so nobody discovers a mapping mistake in production. `reconcile` exists because
a migration is not done when the records land, it is done when the money
matches.

## The design

Every adapter maps its source into one canonical model, and one loader writes
that model into the target. Adding a source means writing an extractor and a
mapping, never touching the loader.

Every canonical record carries `sourceSystem`, `sourceId` and `sourcePayload`.
That makes the load idempotent, makes reconciliation possible, and means a
botched run is re-runnable instead of a restore from backup.

See `src/canonical/index.ts` and `src/adapters/types.ts`. Both are short and
worth reading before contributing.

## The hard parts

Not extraction. Budget your time here instead:

- **Recurring schedules.** Every platform models recurrence differently: a
  rule, a materialized series, anchored to completion, or a manually maintained
  list. Getting it wrong means a customer misses a maintenance visit.
- **Partial payments and credit memos.** Allocations across multiple invoices,
  deposits held against unstarted work. Totals must match to the cent.
- **Custom fields.** Arbitrary shape, inconsistent typing, often carrying
  critical operational data in a free text field.
- **Attachments.** Tens of thousands of photos behind expiring signed URLs.
- **Historical tax rates.** Stored as applied, never recomputed.
- **Technician identity.** Names do not match, people left, records reference
  deleted users. Human in the loop, always.

## The line we do not cross

Every adapter runs on credentials or file exports **you provide for your own
account**. No scraping, no shared credentials, no working around any platform's
terms of service.

### ServiceTitan works differently

For ServiceTitan this toolkit does not connect to anything. **You** run an
extraction against **your own tenant** with credentials **you** obtained, and
this repo imports the snapshot you produced. We never hold your credentials and
never call their API.

Practically that means the ServiceTitan path is a documented, self run script
plus a generic snapshot importer, rather than an adapter in the sense the
others are.

## Contributing

If you have exported data out of any of these platforms, you know something we
do not. Open an issue and tell us what broke. That is worth more than code
right now.

## License

[Apache 2.0](LICENSE).
