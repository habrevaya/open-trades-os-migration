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

## 0. Set up the target

Before anything is loaded, an owner of the target company:

1. Installs a connected app for the migration (Settings, Apps) with read and
   write on customers, properties, the price book, jobs and visits
   (`job:complete` too), estimates, invoices (`invoice:void`,
   `invoice:writeoff`), payments (`payment:collect`, `payment:read`,
   `payment:refund`) and documents, `user:read`, and **`data:import`**, and
   the **`all` scope on customers, jobs, estimates and invoices**. Issues it a
   token.
2. Decides about closed accounting periods. Nothing posts into one, whoever
   asks: history inside it is refused record by record until it is reopened.
3. **Pauses automations that message customers on "created" events.**
   Back-dated invoices, payments and completions announce nothing, but a
   customer, job or visit created by the load does.
4. After the migration, revokes the token, or at least takes `data:import`
   away from the app.

`data:import` is what lets the token record history: an invoice issued, a
payment received, a refund paid or a job finished more than seven days ago,
a source document's own number, and tax as another system charged it. Only
the owner preset holds it, so only an owner can grant it, and that is the
point. Without it, `load` stops before its first write and says so.

`load` needs an OpenTradesOS that answers `GET /v1/apps/me`, which is how
it learns what the token holds without writing anything. On an older core
it stops and asks for an upgrade.

## 1. Map

```
npx @opentradesos/migrate map --in ./snapshot [--target https://ots.example.com]
```

Writes `snapshot/mapping.json`. It lists every value the source uses for a
job status, visit status, invoice status, estimate status, payment method and
payment status, each with the toolkit's guess beside it, and every
technician and job type with a slot for the target id.

With `--target` (and `OPENTRADESOS_TOKEN`), `map` reads the people
(`GET /v1/people`) and job types (`GET /v1/job-types`) the target already has
and fills the slots it can: a technician whose email, or failing that whose
name, picks out exactly one person, and a job type whose name or code matches
exactly one. Each proposal is marked in `proposed` with how it was matched.
Check them. A value already in the file is never replaced, and a name two
people share is listed and left for you.

The rest you fill in by hand. OpenTradesOS creates no people through its API,
by design (`user.create` in [target-api-gaps.md](target-api-gaps.md)), so a
technician who left before the migration and has no account in the target
stays `null`, is dropped from the visits they worked, and the reports count
every one.

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
computed from the lines with the core's own arithmetic and checked against
`expectedTotals` to the cent, a stated tax refused more than a cent from its
rate, history refused without `data:import`, dates in the future refused,
deposits held unapplied, visits deduplicated by key, records found by
`externalRef`.

`--without-import` runs it as a token without `data:import`, to see the
refusal before anybody has to ask an owner. The scratch tenant answers
`GET /v1/apps/me` too, so the dry run makes the same check `load` does.

The report has four parts:

- **Counts per entity:** new, already loaded, mapped, skipped on purpose,
  blocked, invalid, refused, unreadable.
- **Every record that would not land, and why:** the field path the target
  would refuse (`address.postalCode: String must contain at least 1
  character(s)`), or the record it is waiting for (`job Z2lk...MDI=: customer
  Z2lk...OTk5 is not in the target`).
- **What the target API could not take**, counted per gap.
- **A predicted reconcile:** what `reconcile` would say after the real load.
  If it shows invoices short by tax, that is `invoice.tax` on invoices whose
  tax no taxable line can carry, and `--carry-totals` is the decision to make.

Exit code 1 if anything would fail.

## 3. Load

```
export OPENTRADESOS_TOKEN=ots_...
npx @opentradesos/migrate load --in ./snapshot --target https://ots.example.com
```

The token is the connected-app token from step 0. Like every credential here
it comes from the environment, never a flag.

Before its first write `load` reads `GET /v1/apps/me`, which names the app
behind the token, the company it belongs to, exactly the permissions the
install granted and the scope on every scoped resource. It prints the app
and the company, then checks the token against what this snapshot will
actually make it do:

| The snapshot holds | The token needs |
|---|---|
| anything | `data:import` |
| customers | `customer:write`, `customer:read`, and the `all` scope on customers |
| properties | `property:write`, `property:read` |
| price book items | `pricebook:write`, `pricebook:read` |
| jobs | `job:write`, `job:read`, and the `all` scope on jobs |
| jobs with visits | `visit:write`, `job:complete` |
| recurring schedules | `job:write`, `job:read` |
| estimates | `estimate:write`, `estimate:read`, and the `all` scope on estimates |
| invoices | `invoice:write`, `invoice:read`, `invoice:void`, `invoice:writeoff`, and the `all` scope on invoices |
| payments | `payment:collect`, `payment:read` |
| refunds | `payment:refund`, `payment:read` |
| attachments | `document:write`, for the `attachments` pass after load |

Anything short stops the load with one message naming every missing
permission and every scope that is not `all`, so the owner is asked once.
Nothing is written to find this out. An app is nobody anything is assigned
to, so under any scope narrower than `all` it lists none of what it made,
and nothing loaded could be found again or reconciled.

The first run records the company (`organizationId`) in the ledger, and every
run after it refuses to resume if the token belongs to a different one. That
is stronger than the ledger's host check: one deployment serves many
companies, and a ledger resumed with another company's token would skip
records that are not there and link the rest to ids that do not exist.

A core that answers `GET /v1/apps/me` with a 404 is older than this toolkit
supports (or the token is not an app token). `load` stops and says to upgrade;
it never falls back to finding out by writing.

`--target` takes the deployment's address; `/api` is added, and a pasted
`/api` or `/api/v1` is understood.

Order, and why:

| Stage | Through | Notes |
|---|---|---|
| users | `mapping.json` | Mapped to technicians who exist, not created |
| customers | `POST /v1/customers` | |
| contacts | | Reported, not loaded: no route (`contact.create`) |
| properties | `POST /v1/properties`, `POST /v1/properties/{id}/customers` | A property held by two customers is one property with two links |
| equipment | | Reported, not loaded: no route (`equipment.create`) |
| price book | `POST /v1/pricebook/items`, `.../{id}/active` | Inactive items are retired after creation |
| jobs | `POST /v1/jobs`, `POST /v1/jobs/{id}/visits`, `POST /v1/visits/{id}/complete`, `PATCH /v1/jobs/{id}` | The source's number; first timed visit inline, the rest added, cancelled ones as cancelled and untimed ones with no window; completions at the source's own times; status walked forward, the move to completed carrying when it was finished |
| recurring | `POST /v1/recurring-schedules`, `.../completed`, `.../exceptions`, `.../active` | Started at the next occurrence, never at the source's start date; last completion and exceptions recorded; paused where the source already booked occurrences as jobs |
| estimates | `POST /v1/estimates`, `.../{id}/decline` | Number, issue date, the rate that gives the source's tax |
| invoices | `POST /v1/invoices`, `.../{id}/void` | Number, issue date, tax as charged, one adjustment, lines linked to the price book as sold, totals checked to the cent; voided before any payment can land |
| payments | `POST /v1/payments` | Received date; allocated exactly as the source allocated them, and money applied to nothing held for the customer |
| refunds | `POST /v1/payments/{id}/refunds` | Against the one payment that can have given them back, and otherwise reported |
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

The ledger is not the only guard. Every create, visits included, carries an
`Idempotency-Key` derived from the source system, source account and source
id, so a request the target completed just before the process died is sent
again with the same key and the target returns what it already made. Every
create also carries an `externalRef` naming the source record, which the
target holds once per company: a create it has seen under another key is a
409 naming the record, and the loader adopts it.

If the ledger is lost, `load --rebuild-ledger` reads everything this snapshot
already loaded back out of the target by `externalRef` (customers, properties,
price book items, jobs, estimates, invoices, payments, and whether each was
voided, written off, declined or retired), writes the missing ledger lines,
and carries on. Visits are found again on their job, by `externalRef`, when
the job is reached. Recurring schedules carry no `externalRef` and are found
by what they are.

The `externalRef` source is printed at the top of the report: the source
system and eight characters of the ledger namespace (`jobber.3fa9c2d1`), so
two exports whose ids overlap never adopt each other's records. To ask the
target where a source record went:
`GET /api/v1/invoices?externalSource=jobber.3fa9c2d1&externalId=<jobber id>`.

The test suite kills a load after each of its writes in turn, resumes it,
and checks the target ends in the same state as an uninterrupted run, every
time.

A ledger belongs to one target. Pointing the same snapshot at a scratch
tenant and then production gives each its own file; `load` refuses to resume
a ledger written for a different target, or for a different company on the
same one.

### Rate limits and failures

Requests go through the same transport as extraction: 429 and 5xx are
retried with exponential backoff and full jitter, and `Retry-After` is
honoured. A refusal of one record (422, 404, 409) is reported against that
record and the run continues: an invoice inside a closed period, a total that
does not add up. A document whose number the target already uses loads with
the next number (`document.number_taken`). A refused token, a missing
permission (403, named in the report), or a target that keeps failing after
the retries, stops the run, because carrying on would mark thousands of good
records as failed for a reason that has nothing to do with them.

## 4. Attachments

```
npx @opentradesos/migrate attachments --in ./snapshot [--target https://ots.example.com] [--no-upload]
```

Downloads every attachment the source exposes into `snapshot/attachments`,
one folder per record, with `index.ndjson` recording the source, size,
SHA-256 and (with `--target`, after `load`) the target record each belongs
to. Resumable: a file already in the index is not fetched again. Signed URLs
that redirect are followed; an expired one (403) is reported, not retried.

With `--target`, each file is then attached to its record in OpenTradesOS
(`POST /v1/attachments`, base64, an Idempotency-Key per file), and recorded in
the ledger, so a re-run attaches nothing twice. What the target will not store
is listed without being sent (`attachments.unattachable`): files on
equipment, files over 20 MB, and anything whose first bytes are not PNG,
JPEG, GIF, WebP, ICO, HEIC or PDF. `--no-upload` only downloads and indexes.
Of the built-in sources Generic CSV and canonical imports carry attachments;
Jobber and Housecall Pro do not expose them through their public APIs.

## 5. Reconcile

```
npx @opentradesos/migrate reconcile --in ./snapshot --target https://ots.example.com
```

Reads the target back through its list endpoints, counting only the records
this migration's ledger names (anything else in the tenant is reported
separately and not counted), and compares counts and four dollar totals with
the snapshot: invoiced, open balance, payments, and payments allocated.
Tolerance is zero cents unless `--tolerance-cents` says otherwise.

Payments are read back through `GET /v1/payments`, page by page under
`data`, following `nextCursor` until `hasMore` is false: their count, and
what arrived less what was refunded. The `totals` and `byMethod` beside each
page are the core's banking summary for the whole company, over at most 500
payments, so reconcile does not use them; it sums the payments this
migration's ledger names. A refund counts as present when the payment
it was recorded against is. The report says how much is held for customers,
applied to no invoice. Recurring schedules are counted too.

`--against <file>` still compares against a JSON summary, for a target that
is not OpenTradesOS.

## Not loaded, and why

- **Contacts** (`contact`, from Generic CSV and canonical imports): the
  target has no route that creates one. Counted as `contact.create`.
- **Equipment** (`equipment`, from FieldEdge, Generic CSV and canonical
  imports): the target has no route for a customer's equipment
  (`/v1/assets` is the company's own kit). Counted as `equipment.create`.
- **Recurring schedules that are not running**, rules the target cannot
  repeat, and the terms of a service agreement: see Recurring work in
  [target-api-gaps.md](target-api-gaps.md). Jobber and Housecall Pro deliver
  recurring work as the jobs and visits already created, which load.
