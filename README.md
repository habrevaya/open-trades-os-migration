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

**Phase 2.** Three sources read, and all seven commands run: a snapshot now
lands in OpenTradesOS, through its public API, resumably, and reconciles
against it to the cent or says exactly why not.

| Source | Route | Status |
|---|---|---|
| Jobber | GraphQL, OAuth | **Reads.** Clients, properties, quotes, jobs with visits, invoices, payments, products, users |
| Housecall Pro | REST, OAuth or API key | **Reads.** Customers with derived properties, estimates, jobs, invoices, employees |
| Generic CSV | Mapped CSV | **Reads.** Every entity, equipment, contacts and recurring schedules included, from any export, with a column mapping. See [docs/generic-csv.md](docs/generic-csv.md) |
| Canonical snapshot | Files you produce | **Imports** records already in the canonical shape, for any source this toolkit does not connect to. See [docs/snapshot-format.md](docs/snapshot-format.md) |
| Workiz | REST, API key | **Reads.** Jobs with team, customers and properties split out of them, invoices from job totals, team. No payments, lines or leads: the public API does not list them. See [docs/workiz.md](docs/workiz.md) |
| ServiceM8 | REST, OAuth | Planned |
| ServiceTitan | Your own export | **Imports** the snapshot you produce from your own tenant, checked record by record against the canonical schema. Connects to nothing. See below and [docs/servicetitan.md](docs/servicetitan.md) |
| FieldEdge | CSV export only | **Reads** FieldEdge's own five exports (customers, dispatches, invoices, quotes, equipment) with their columns built in. No payments or lines: not exported. See [docs/fieldedge.md](docs/fieldedge.md) |

| Command | Status |
|---|---|
| `sources` | Works. Lists what each adapter reads and what it cannot |
| `extract` | Works. Resumable, checkpointed, rate limit aware |
| `profile` | Works. Counts, date spans, fill rates, money totals, findings |
| `map` | Works. Writes `mapping.json`: technicians, job types, statuses, payment methods. You edit it; re-running keeps your edits |
| `dryrun` | Works. The real loader against a scratch tenant in memory: every request validated, every failure named, reconcile predicted |
| `load` | Works. Public API only, dependency ordered, resumable from a local ledger, idempotent on source ids |
| `attachments` | Partly. Downloads, hashes and indexes every file locally. Cannot attach them: the target API has no upload route yet |
| `reconcile` | Works. Reads the target back and compares counts and four dollar totals |

What the target's API cannot yet take is not faked. It is listed, endpoint
by endpoint, in [docs/target-api-gaps.md](docs/target-api-gaps.md), and every
load and dry run counts the records each gap touched. The two that cost the
most: historical tax is not carried (the target computes tax as zero), and
everything posts to the ledger dated the day of the load.

The mapping and loading logic is covered by 184 tests against fixtures and
a fake OpenTradesOS served over real HTTP, including a load killed after each
of its writes in turn and resumed. What no test can tell you is whether a
real tenant matches the fixtures, and for some field the answer will be no.
That is what `profile` and `dryrun` are for, and why `load` is last.

## Try it without risking anything

`extract` and `profile` never write to a target. They answer the question
everybody actually has first, which is what is in there.

```
export JOBBER_TOKEN=...          # never a command line flag: shell history
npx @opentradesos/migrate extract --source jobber --out ./snapshot
npx @opentradesos/migrate profile --in ./snapshot
```

The profile is the point. A real one looks like this:

```
RECORDS
  customer             9412  2009-06-02 to 2026-09-18
  job                 41022
  invoice             38110

MONEY
  invoiced              $4,120,611.80
  open balance             $41,206.18
  unapplied                 $3,900.00

FINDINGS
  [error] job.orphan_property
    38 job(s) name a property that is not in the snapshot.
  [warning] customer.no_contact
    1180 customer(s) have neither an email nor a phone number.
  [info] payment.unallocated
    14 payment(s) are not applied to any invoice. These are deposits.
```

Every migration conversation starts with "about eight thousand customers,
going back maybe twelve years". This is where that becomes a number, and
where the 1,180 customers you cannot email turn up before the cutover rather
than after it.

## Then load it

```
npx @opentradesos/migrate map --in ./snapshot        # then edit snapshot/mapping.json
npx @opentradesos/migrate dryrun --in ./snapshot
export OPENTRADESOS_TOKEN=ots_...                     # a connected app token
npx @opentradesos/migrate load --in ./snapshot --target https://ots.example.com
npx @opentradesos/migrate reconcile --in ./snapshot --target https://ots.example.com
```

`dryrun` runs the same loader, request for request, against an in-memory
tenant that behaves as the target's services do, and ends with the reconcile
you would get. The report reads like this (numbers illustrative):

```
                    new already  mapped skipped blocked invalid refused  unread
  customers        9411       -       -       -       -       -       -       1
  properties      11020       -       -       -       -       3       -       -
  jobs            40984       -       -       -      38       -       -       -

WOULD BE REFUSED BY THE TARGET (3)
  property adr_9: the target's contract refuses this record
      address.line1: String must contain at least 1 character(s)

WAITING ON A RECORD THAT DID NOT LOAD (38)
  job 1043: property 999 is not in the target

WHAT THE TARGET API COULD NOT TAKE (docs/target-api-gaps.md)
   38110  invoice.issued_on: The historical issue date is replaced by the load date...
      14  payment.unapplied: A deposit or account credit cannot be recorded as unapplied money...
```

`load` keeps a ledger beside the snapshot, source id to target id, and sends
every create with an idempotency key derived from the source record. Kill it
at any point and run it again: nothing is created twice and nothing is
skipped. See [docs/loading.md](docs/loading.md).

## How it works

Seven commands, each idempotent and resumable, each producing an artifact you
can inspect before the next one runs.

```
extract      Pull into a local raw snapshot. Never writes to the target
profile      Report counts, date ranges, fill rates, custom fields, anomalies
map          Map technicians, job types and statuses. Saved, reusable, yours to edit
dryrun       The real load into a scratch tenant in memory. Touches nothing
load         Through the public API. Resumable, idempotent on source ids
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

The loader writes only through OpenTradesOS's public HTTP API, with a
connected-app token, never to its database. That is what lets it work against
any deployment, hosted or self hosted, and what makes every migrated record
go through the same rules (ledger postings, the job lifecycle, the audit
trail) as one typed in by hand. Where that API cannot yet take something,
the gap is written down rather than worked around.

Money is never a JS number anywhere in this toolkit. Every amount is a decimal
string, and every operation on one goes through `src/money`, which holds it as
a scaled bigint. `0.1 + 0.2` is the reason reconciliation reports lie.

See `src/canonical/index.ts` and `src/adapters/types.ts`. Both are short and
worth reading before contributing.

### What the two adapters taught us

Writing the second adapter is what proved the contract, and the two differ in
exactly the ways that matter:

- **Jobber** sends money as float dollars. **Housecall Pro** sends integer
  cents. One line that forgets which is a hundredfold error.
- **Jobber** has real property records. **Housecall Pro** keeps addresses on
  the customer, so the adapter splits one record into a customer plus N
  properties and mints stable property ids. Those ids have to survive a
  re-run, a renamed site and inconsistent spacing, or a re-import duplicates
  every property a shop owns.
- **Jobber** pages by cursor. **Housecall Pro** pages by number, so a record
  created mid-run shifts every page after it. That cannot be prevented, so the
  adapter detects the repeat and says how bad the drift was.

None of that reached the loader. That is the contract working.

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

Practically that means the ServiceTitan path is a documented snapshot format
plus an importer that checks every record against it, rather than an adapter
in the sense the others are. See [docs/servicetitan.md](docs/servicetitan.md).

## Contributing

If you have exported data out of any of these platforms, you know something we
do not. Open an issue and tell us what broke. That is worth more than code
right now.

## License

[Apache 2.0](LICENSE).
