# Loading into OpenTradesOS

The second half of a migration: `map`, `dryrun`, `load`, `attachments` and
`reconcile`. Each one reads the snapshot `extract` wrote and leaves a file
beside it that the operator can open.

```
snapshot/
  manifest.json, *.ndjson         extract
  mapping.json                    map (you edit this)
  load/<host>.ledger.ndjson       load, one per target
  attachments/                    attachments, with index.ndjson
```

## 1. Map

```
npx @opentradesos/migrate map --in ./snapshot
```

Writes `snapshot/mapping.json`. It lists every value the source uses for a
job status, visit status, invoice status, estimate status, payment method and
payment status, each with the toolkit's guess beside it, and every
technician and job type with an empty slot.

Fill in the technicians. OpenTradesOS has no API to create or list users, by
design and for now respectively (see `user.create` in
[target-api-gaps.md](target-api-gaps.md)), so copy each person's user id
from the target's settings. A technician left as `null` is dropped from the
visits they worked, and the reports count every one.

Check the job statuses. A `null` leaves the job wherever creation puts it.
`invoiced` and `paid` are never set directly; a job reaches them when its
invoice and payments load, which is the only way the target's ledger agrees.

Run `map` again after editing. It adds values it has not seen, never changes
one you set, and refuses an id that is not an id.

## 2. Dry run

```
npx @opentradesos/migrate dryrun --in ./snapshot [--carry-totals] [--json dryrun.json]
```

Runs the real loader, request for request, against a scratch tenant held in
memory. Nothing is written anywhere. Every body is validated against the
target's contracts (mirrored in `src/target/contracts.ts`), every reference is
resolved, and the in-memory tenant behaves as the core's services do: totals
recomputed from lines, tax at zero, today's issue date, unapplied payments
spread oldest first.

The report has four parts:

- **Counts per entity:** new, already loaded, mapped, skipped on purpose,
  blocked, invalid, refused, unreadable.
- **Every record that would not land, and why:** the field path the target
  would refuse (`address.postalCode: String must contain at least 1
  character(s)`), or the record it is waiting for (`job Z2lk...MDI=: customer
  Z2lk...OTk5 is not in the target`).
- **What the target API could not take**, counted per gap.
- **A predicted reconcile:** what `reconcile` would say after the real load.
  If it shows the invoices short by exactly the source's tax, that is
  `invoice.tax`, and `--carry-totals` is the decision to make.

Exit code 1 if anything would fail.

## 3. Load

```
export OPENTRADESOS_TOKEN=ots_...
npx @opentradesos/migrate load --in ./snapshot --target https://ots.example.com
```

The token is a connected-app token from the target (Settings, Apps). It
needs `customer:write`, `property:write`, `pricebook:write`, `job:write`,
`visit:write`, `job:complete`, `estimate:write`, `invoice:write`,
`invoice:void`, `invoice:writeoff` and `payment:collect`, plus the matching
`:read` permissions for reconcile. Like every credential here it comes from
the environment, never a flag.

`--target` takes the deployment's address; `/api` is added, and a pasted
`/api` or `/api/v1` is understood.

Order, and why:

| Stage | Through | Notes |
|---|---|---|
| users | `mapping.json` | Mapped, not created |
| customers | `POST /v1/customers` | |
| properties | `POST /v1/properties`, `POST /v1/properties/{id}/customers` | A property held by two customers is one property with two links |
| price book | `POST /v1/pricebook/items`, `.../{id}/active` | Inactive items are retired after creation |
| jobs | `POST /v1/jobs`, `POST /v1/jobs/{id}/visits`, `POST /v1/visits/{id}/complete`, `PATCH /v1/jobs/{id}` | First visit inline, the rest added, completions at the source's own times, status walked forward along the target's lifecycle |
| estimates | `POST /v1/estimates`, `.../{id}/decline` | |
| invoices | `POST /v1/invoices`, `.../{id}/void` | Voided before any payment can land |
| payments | `POST /v1/payments` | Allocated exactly as the source allocated them |
| write-offs | `POST /v1/invoices/{id}/write-off` | Last, because a write-off takes what payments left |

Every reference is resolved through the ledger. A record whose customer,
property, job or invoice did not load is **blocked**, named in the report
with what it was waiting for, and not sent half-linked. A payment loads with
all of its allocations or none.

### Resuming, and why nothing duplicates

The ledger (`snapshot/load/<host>.ledger.ndjson`) gets a line the moment the
target confirms each record. Re-running `load` skips everything in it, which
is the recovery for every kind of interruption: a crash, a closed laptop, a
rate limit that outlasted the retries, a fix to `mapping.json`.

The ledger is not the only guard. Every create carries an `Idempotency-Key`
derived from the source system, source account and source id, so a request
the target completed just before the process died is sent again with the
same key and the target returns what it already made. That holds even if the
ledger file is lost entirely. Visits are the exception: the target does not
deduplicate them (`visit.idempotency`), so on a resumed job the loader reads
the job back and adopts a visit already there at the same window rather than
adding a second.

The test suite kills a load after each of its writes in turn, resumes it,
and checks the target ends in the same state as an uninterrupted run, every
time.

A ledger belongs to one target. Pointing the same snapshot at a scratch
tenant and then production gives each its own file; `load` refuses to resume
a ledger written for a different target.

### Rate limits and failures

Requests go through the same transport as extraction: 429 and 5xx are
retried with exponential backoff and full jitter, and `Retry-After` is
honoured. A refusal of one record (422, 404, 409) is reported against that
record and the run continues. A refused token, or a target that keeps failing
after the retries, stops the run, because carrying on would mark thousands of
good records as failed for a reason that has nothing to do with them.

## 4. Attachments

```
npx @opentradesos/migrate attachments --in ./snapshot [--target https://ots.example.com]
```

Downloads every attachment the source exposes into `snapshot/attachments`,
one folder per record, with `index.ndjson` recording the source, size,
SHA-256 and (with `--target`, after `load`) the target record each belongs
to. Resumable: a file already in the index is not fetched again. Signed URLs
that redirect are followed; an expired one (403) is reported, not retried.

The files are **not** attached in OpenTradesOS, because its API has no route
for a third party to do so (`attachments.upload`). Of the built-in sources
only Generic CSV carries attachments; Jobber and Housecall Pro do not expose
them through their public APIs.

## 5. Reconcile

```
npx @opentradesos/migrate reconcile --in ./snapshot --target https://ots.example.com
```

Reads the target back through its list endpoints, counting only the records
this migration's ledger names (anything else in the tenant is reported
separately and not counted), and compares counts and four dollar totals with
the snapshot: invoiced, open balance, payments, and payments allocated.
Tolerance is zero cents unless `--tolerance-cents` says otherwise.

Payments cannot be listed through the API (`read.payments`), so their count
and total come from what the target confirmed when each was recorded, and
the report says so. Allocated money is verified, through the invoices.

`--against <file>` still compares against a JSON summary, for a target that
is not OpenTradesOS.

## Not loaded yet

These have canonical shapes and adapters that produce them, so `extract` and
`profile` carry and check them, but `load` does not write them yet:

- **Recurring schedules and service agreements** (`recurringSchedule`). The
  target has `/v1/recurring-schedules`. Produced today by Generic CSV
  (`recurring_schedules.csv`). No API adapter reads a recurrence rule yet:
  Jobber and Housecall Pro deliver recurring work as the jobs and visits
  already created, which `sources` says for each. See
  [recurring-schedules.md](recurring-schedules.md).
- **Equipment**, on properties, with serials and warranty dates
  (`equipment`). Produced by FieldEdge (Equipment List) and Generic CSV
  (`equipment.csv`).
- **Contacts** beyond the customer's own email and phone (`contact`).
  Produced by Generic CSV (`contacts.csv`).
