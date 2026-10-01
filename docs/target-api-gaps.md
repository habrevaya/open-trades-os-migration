# What the target API takes, and what it still cannot

`load` writes into OpenTradesOS only through its public HTTP API
(`/api/v1`, a connected-app bearer token), never its database. That is
deliberate: this toolkit has to work against any deployment, hosted or self
hosted, and the API is the only surface that promises the same behaviour on
all of them. It also means every service rule (the ledger postings, the job
lifecycle, the audit trail, who may back-date what) applies to migrated data
exactly as it does to data typed in by hand.

The cost is that wherever the source has a fact and the API cannot accept
it, the fact does not arrive. This file lists every such place found while
writing the loader against the contracts in
`packages/api/src/contracts/*.ts` and the services behind them, and what has
happened to each since. The loader does not fake any of them. It loads what
the API accepts, and counts every record that lost something against the gap
that lost it, so the load and dryrun reports say "38 invoices lost their tax"
rather than nothing. The codes are the ones those reports print, from
`src/load/gaps.ts`, where each carries the same status as here.

Most of the list was closed in the core on `claude/eager-hamilton-92klqv`
(commits named beside each). A closed gap stays listed so that an older
report still explains itself; the loader never counts a record against one.

## Status at a glance

| Gap | Status | Now |
|---|---|---|
| `external-id` | **closed** | `externalRef` on every create, 409 naming the record on a repeat, filterable on every list (ca51de1) |
| `invoice.issued_on`, `ledger.dates` | **closed** | `issuedOn` and `receivedAt` date the postings (cfa5dc8) |
| `job.completed_at` | **closed** | `completedAt` with the move to completed (cfa5dc8) |
| `job.number`, `invoice.number`, `estimate.number` | **closed** | `number` on create (ca51de1) |
| `document.number_taken` | open | a number the target already uses is refused; the document takes the next one |
| `invoice.tax` | partly | per-line `taxRate` and `taxAmount` (4745ce4); lost only where no taxable line can carry it within a cent |
| `invoice.totals` | **closed** | `adjustment` and `expectedTotals` (4745ce4) |
| `invoice.reprice` | **closed** | `priceAsGiven` (4745ce4) |
| `invoice.item_unlinked` | open | a line whose price book item did not load is not linked |
| `payment.unapplied` | **closed** | `allocations: []` holds the money as `unappliedAmount` (eec32cf) |
| `payment.refund` | partly | `POST /v1/payments/{id}/refunds` (19c6140); a source rarely says which payment a refund gave back |
| `read.payments` | **closed** | `GET /v1/payments` (6d06c0f) |
| `user.create`, `user.unmapped` | partly | `GET /v1/people` (6d06c0f); nobody can be created, and a person without a login cannot be recorded |
| `job.job_type` | partly | `GET /v1/job-types` (6d06c0f); none can be created |
| `visit.cancelled`, `visit.unscheduled` | **closed** | `status: "cancelled"`, and a window of both ends or neither (19c6140) |
| `visit.idempotency` | **closed** | `addVisit` honours the key (0a77904) |
| `attachments.upload` | **closed** | `POST /v1/attachments` (32130f0) |
| `attachments.unattachable` | open | six kinds of record, 20 MB, images and PDF only |
| `estimate.dates` | partly | `issuedOn` (cfa5dc8); no sent, viewed or decided date |
| `estimate.tax` | partly | per-line `taxRate` (4745ce4); no stated amount |
| `estimate.status` | open | no historical approval |
| `estimate.reprice` | open | no `priceAsGiven` on an estimate line |
| `history.future` | open, by design | the target refuses a date after today |
| `recurring.*` | open | see Recurring work |
| `contact.create`, `equipment.create` | open | no route |
| `customer.notes`, `customer.billing_incomplete`, `customer.contact_invalid` | open | |
| `property.coordinates`, `pricebook.code` | open | |

## What the token must hold

History is recorded, not made, and recording it is also how books are
cooked, so the core gates it behind one permission, **`data:import`**: a
business date more than seven days back (an invoice's `issuedOn`, a
payment's `receivedAt`, a refund's `refundedAt`, a job's `completedAt`), a
source document `number`, a line's `taxRate`, `taxAmount` or `priceAsGiven`.
Only the owner preset holds it, so only an owner can give it to the
migration's app. Without it each of those is a 403 `Missing permission:
data:import`. `load` asks before its first write, with an invoice the target
refuses either way and stores nothing from, and stops at once if the answer
is no.

The app also needs the **`all` scope** on customers, jobs, estimates and
invoices. With a narrower one, a list returns only some records and none of
the app's own, so nothing loaded could be found again or reconciled. `load`
checks after the first record of each kind that it can see it, and stops if
it cannot.

Nothing posts into a **closed accounting period**, whoever asks: an invoice,
payment or refund dated inside one is a 409 against that record. Reopen the
period first, or leave that history out.

Back-dated invoices, payments and completions emit no domain events, so no
"your invoice is ready" goes out about 2021. Undated creates (customers,
jobs, visits) do: **pause automations that message customers on "created"
events** for the length of the migration.

## Money

### `invoice.tax`: partly closed

Was: every line taxed at zero and client totals ignored, so an invoice that
charged $26.24 of sales tax loaded $26.24 short.

Now (4745ce4): a line takes `taxRate` and `taxAmount` as another system
charged them, a stated amount accepted only within a cent of its rate on the
line's net. The loader sends, in order of how much of the source it keeps:
the source's own per-line tax where it itemised one that adds up; otherwise
the one rate that reproduces the invoice's tax under the target's own
arithmetic (each line at four places, rounded once per document), which is
what nearly every invoice actually was; otherwise the nearest rate with the
few cents it misses by stated across the taxable lines, each within a cent.

Still lost: tax on an invoice with no taxable line to carry it, or so far from
any rate on a single large line that no line can carry it within a cent. Those
are counted here. `--carry-totals` puts that tax in the invoice's adjustment
instead, so the total still matches, at the cost of recording tax as a line.

### `invoice.totals`: closed

Was: the total was recomputed from lines, so an invoice-level discount, a
manual adjustment or lines a source API truncated loaded at a different total.

Now (4745ce4): one invoice-level `adjustment` (negative is a discount, posted
to contra revenue), and `expectedTotals`, which refuses any invoice whose
computed total differs from it by a cent. The loader predicts the target's
totals with the same arithmetic (`src/target/totals.ts`), sends the
difference from the source's total as the adjustment ("Not itemised on jobber
invoice #2202", "Discount on ..."), and sends the source's totals as the cross
check. An invoice that would load at a different total from the one the
customer was sent is refused rather than stored.

### `invoice.issued_on` and `ledger.dates`: closed

Was: everything issued and posted on the day of the load; ten years of
revenue in one period and every invoice "current" on the aging report.

Now (cfa5dc8): `issuedOn` on invoices and estimates, and the ledger postings
for invoices, payments and refunds dated by `issuedOn`, `receivedAt` and
`refundedAt`. Sent. A date in the future is refused by the target and left
off by the loader (`history.future`).

### `payment.unapplied`: closed

Was: a payment with no allocations paid the customer's oldest invoices, so a
deposit taken last week settled an invoice from 2021, and the loader did not
send one.

Now (eec32cf): omitted allocations still mean oldest first, and an empty list
means applied to nothing, held for the customer as a liability and returned as
`unappliedAmount`. The loader always sends an explicit list, empty included,
so deposits and credits load. Reconcile reports how much is held.

### `payment.refund`: partly closed

Now (19c6140): `POST /v1/payments/{id}/refunds` records a refund paid by
hand, out of held money first and then reopening what the payment paid.

Still lost: a source records a refund as a negative payment and almost never
says which payment it gave back. The loader records one only where the answer
is forced: exactly one of the customer's loaded payments was received on or
before it, is at least as large, and paid every invoice the refund names. Any
other refund is reported, with how many payments could have been the one.

### `invoice.reprice`: closed

Was: a line linked to the price book was re-priced at today's price, so
historical lines were not linked.

Now (4745ce4): `priceAsGiven: true` links the item and keeps the line's own
name, price and taxability. Sent. A line whose item did not load is left
unlinked (`invoice.item_unlinked`).

### `read.payments`: closed

Now (6d06c0f): `GET /v1/payments`, with allocations, `refundedAmount` and
`unappliedAmount`. `reconcile --target` reads payments back rather than
trusting what the target said when each was recorded.

## Identity

### `external-id`: closed

Was: the only map from a source id to what it became was a file on the laptop
that ran the migration.

Now (ca51de1): every importable create takes `externalRef: { source, id }`,
unique per company and kind of record; a second create for it is a 409 naming
the record it became; every read returns it; every list finds by it
(`externalSource`, `externalId`). The loader sends it on every create, visits
included (as `<job id>#<visit id>`), adopts the record a 409 names, and
`load --rebuild-ledger` rebuilds a lost ledger from the target.

The `source` is the source system and eight characters of the ledger
namespace, `jobber.3fa9c2d1`, not the bare name. Two exports whose ids
overlap (two spreadsheets that both start at C-1, two companies merging into
one tenant) would otherwise adopt each other's records. The load report
prints it.

### `job.number`, `invoice.number`, `estimate.number`: closed

Now (ca51de1): an optional `number` on create, with `data:import`, refused if
taken, and the next number always past the highest in use. Sent.

### `document.number_taken`: open

A company that used OpenTradesOS before migrating may already have invoice
2201. The target refuses the number; the loader loads the document with the
next number and counts it here.

## People

### `user.create` and `user.unmapped`: partly closed

Now (6d06c0f): `GET /v1/people` lists everyone with their technician id.
`map --target` proposes a technician for every source user an email, or
failing that a name, picks out exactly once.

Still open: no route creates a person, rightly (who may log in is not a
migration's decision), and a technician who left in 2019 and never had a
login here cannot be recorded, so their visits name nobody.

### `job.job_type`: partly closed

Now (6d06c0f): `GET /v1/job-types`, and `map --target` proposes matches by
name or code. A type the target does not have must be made there first.

## Work

### `visit.cancelled` and `visit.unscheduled`: closed

Now (19c6140): `status: "cancelled"` on `POST /v1/jobs/{id}/visits` records
the visit, dispatches nobody and does not hold the job open; and the window is
both ends or neither, neither being a visit nobody timed, kept unassigned. The
loader sends both. (A source's "no show" is recorded as cancelled: the target
has one word for a visit that did not go ahead.)

### `visit.idempotency`: closed

Now (0a77904): adding a visit honours the Idempotency-Key. The loader sends
one per visit, and reads a job back only to adopt visits a lost ledger forgot,
by externalRef.

### `job.completed_at`: closed

Now (cfa5dc8): `PATCH /v1/jobs/{id}` takes `completedAt` with the move to
completed. Sent when no completed visit carries the date.

## Estimates

### `estimate.status`: open

An approved, sent or converted estimate loads as a draft. Recording an
approval needs a signer and how they said yes, and inventing those would
fabricate a record. Declined estimates are recorded as declined.

### `estimate.dates`: partly closed

`issuedOn` is sent (cfa5dc8). When it was sent, viewed or decided cannot be.

### `estimate.tax`: partly closed

Lines take their own `taxRate` (4745ce4), but an estimate takes no stated
amount, so the loader sends the one rate that reproduces the source's tax;
an estimate no rate reproduces loads without tax.

### `estimate.reprice`: open

An estimate line linked to the price book is re-priced, and there is no
`priceAsGiven` for estimates, so estimate lines are not linked.

## Recurring work

`POST /v1/recurring-schedules` exists and the loader uses it, carefully: the
target books a schedule's work from its start date, not from today, so a
weekly rule that started in 2021 would put five years of past visits on the
board. A repeating schedule is therefore started at its next occurrence (the
source's, or the first one on or after today on the source's cadence). Work
counted from completion records the last completion. Skipped, moved and
cancelled occurrences are recorded. The route takes no externalRef and reads
no Idempotency-Key, so a schedule a crashed run made is found again by what
it is.

| Gap | What is lost |
|---|---|
| `recurring.inactive` | An ended, cancelled or paused schedule: the target cannot create one that is not running. Its history is the jobs, which load |
| `recurring.rule` | A rule it cannot repeat: every 5 months, the second Tuesday, months counted from completion |
| `recurring.anchor_day` | Months are pinned to the 15th; the source's day is not settable |
| `recurring.occurrences` | Jobs the source booked from a schedule cannot be linked to it; a repeating one with any is created and then paused, so it does not book them again |
| `recurring.agreement_terms` | A service agreement's price, billing frequency and visits per term |
| `recurring.assignment` | The technicians and equipment a schedule names |

## Customers, properties and the rest

- `customer.notes`: no notes field.
- `customer.billing_incomplete`, `customer.contact_invalid`: the billing
  address is all or nothing and an email must be one. The field is left off
  rather than the customer lost.
- `contact.create`: no route creates a contact (a job's parties can name one).
- `property.coordinates`: no latitude or longitude.
- `equipment.create`: no route creates a customer's equipment; `/v1/assets`
  is the company's own kit.
- `pricebook.code`: required; an item with none gets one derived from its
  name and source id, stable across runs.

## Attachments

### `attachments.upload`: closed

Now (32130f0): `POST /v1/attachments` takes base64 bytes for a customer,
property, job, visit, estimate or invoice. `attachments --target` attaches
every downloaded file, with an Idempotency-Key per file.

### `attachments.unattachable`: open

Equipment has no route; the limit is 20 MB; the type is decided from the first
bytes and must be PNG, JPEG, GIF, WebP, ICO, HEIC or PDF. Those files stay in
the local folder, listed by `attachments`.

## Checked, and not a gap

- **Idempotency keys are tenant scoped.** The services look keys up in
  `integration_event` without an `organization_id` filter, which reads like a
  cross-tenant leak. It is not: every table with an `organization_id` has row
  level security (`db/sql/after.sql`), and services run inside `inTenant`.
- **Job status cannot be set freely.** It is walked through the lifecycle the
  service enforces (`REACHABLE` in `services/jobs.ts`), and the loader never
  walks a job backwards.
- **A property shared by several customers** is supported:
  `POST /v1/properties/{id}/customers` links the second and later ones, and is
  naturally idempotent.
- **Recording a schedule's completion backwards** is refused by the target,
  and the loader treats that refusal on a re-run as "already recorded".
