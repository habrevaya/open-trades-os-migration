# What the target API needs for a lossless load

`load` writes into OpenTradesOS only through its public HTTP API
(`/api/v1`, a connected-app bearer token), never its database. That is
deliberate: this toolkit has to work against any deployment, hosted or self
hosted, and the API is the only surface that promises the same behaviour on
all of them. It also means every service rule (the ledger postings, the job
lifecycle, the audit trail) applies to migrated data exactly as it does to
data typed in by hand.

The cost is that wherever the source has a fact and the API cannot accept
it, the fact does not arrive. This file lists every such place found while
writing the loader against the contracts in
`packages/api/src/contracts/*.ts` and the services behind them. The loader
does not fake any of them. It loads what the API accepts, and counts every
record that lost something against the gap that lost it, so the load and
dryrun reports say "38 invoices lost their historical issue date" rather than
nothing. The codes below are the ones those reports print, from
`src/load/gaps.ts`.

They are ordered by how much they cost a migrating company.

## Money

### `invoice.tax`: tax as applied cannot be carried

`POST /v1/invoices` takes no tax rate or tax amount per line, and the
service sets `taxRate: "0"` on every line ("resolved per jurisdiction in
phase 5"). Client-supplied totals are ignored. A historical invoice that
charged $26.24 of sales tax loads $26.24 short, and its balance is wrong by
the same amount once its payment is applied.

**Needed:** a per-line `taxRate` and `taxAmount` accepted as-applied on
create, at least for an import-scoped caller, so the frozen rate the
contract already promises on `InvoiceLine` can come from the source.

**Meanwhile:** `--carry-totals` adds a non-taxable line named "Sales tax as
applied on <source> invoice #N". The totals then reconcile to the cent, at the
cost of tax being recorded as a line item. Off by default.

### `invoice.totals`: the total is recomputed from lines

Same route. When the source's lines do not add up to its subtotal (an
invoice-level discount, a manual adjustment, or lines the source API
truncated), the target's total differs. A line whose own total is below
quantity times price does travel as `discountAmount`; an invoice-level
difference has nowhere to go.

**Needed:** an invoice-level adjustment or discount field on create.

**Meanwhile:** `--carry-totals` adds a line named "Not itemised on <source>
invoice #N" for the difference.

### `invoice.issued_on` and `ledger.dates`: everything is dated today

`POST /v1/invoices` stamps `issuedOn` with today's date, and both it and
`POST /v1/payments` post to the ledger with `occurredAt: new Date()`. Ten
years of invoices arrive issued on the day of the cutover, AR aging puts all
of them in "current", and ten years of revenue and cash land in one
accounting period. `recordPayment` does accept `receivedAt`, and the loader
sends it, but the ledger posting ignores it.

**Needed:** `issuedOn` on invoice create, and the ledger posting dated from
`issuedOn` / `receivedAt` rather than the wall clock.

**Meanwhile:** the source's number and issue date are written into the
invoice `memo` ("Migrated from jobber invoice #2201, issued 2023-09-21.").

### `payment.unapplied`: a deposit cannot be recorded

`POST /v1/payments` with no `allocations` (or an empty array) applies the
money to the customer's oldest open invoices. There is no way to record a
payment held unapplied: a deposit on unstarted work, or an account credit.
`POST /v1/deposits` only *requests* a deposit. Sending such a payment would
silently pay an invoice from 2021 with a deposit taken last week, so the
loader does not send it; it is reported, with its amount.

**Needed:** either an explicit `allocations: []` meaning "hold unapplied",
or a way to record a deposit as already received (`receivedAt`, `amount`)
against a customer or job.

### `payment.refund`: refunds and reversals cannot be recorded

`POST /v1/payments/{paymentId}/refund` refunds through the processor and
refuses money that did not arrive through one. A historical cheque refund or
a negative adjustment in the source has no route.

**Needed:** a way to record a historical refund against a recorded payment.

### `invoice.reprice`: linking a line to the price book re-prices it

When a line names `priceBookItemId`, the service replaces its `unitPrice`
with the price book item's CURRENT version (or a contract rate card's). For a
new invoice that is the point. For a historical invoice it rewrites what the
customer was charged, so the loader never sends `priceBookItemId` on
historical lines, and the link is lost.

**Needed:** a price-as-given flag for import, or `priceBookItemVersionId`
plus the line's own price accepted together.

### `read.payments`: payments cannot be read back

There is no `GET /v1/payments`. Reconcile reads invoices, customers and the
rest back from the target, but for payments it can only use the amounts the
target confirmed when each was recorded. Allocated money is still verified,
through `amountPaid` on the invoices.

**Needed:** `GET /v1/payments`, filterable by customer, with allocations.

## Identity

### `external-id`: no field carries the source id

No create route has a place for "this record was Jobber client
Z2lkOi8vSm9iYmVy...". The only map from source id to target id is the
loader's local ledger. A customer support question in two years ("where did
Jobber invoice 2201 go") can be answered from the memo on invoices and
payments, and from nothing on customers, properties or jobs.

**Needed:** an `externalRef` (`{ system, id }`) on every create, stored,
returned and filterable on list. It would also let reconcile find migrated
records without the ledger.

### `job.number`, `invoice.number`, `estimate.number`

The target assigns the next number in its own sequence. Customers know
their invoices by number. The invoice memo keeps it; jobs and estimates lose
it.

**Needed:** an optional `number` on create for import, refused if taken,
with the sequence advanced past the highest imported number.

## People

### `user.create` and `user.unmapped`: technicians cannot be created or listed

There is no route to create, invite or list users or memberships (only
`POST /v1/memberships/{id}/active`). Creating logins is rightly not a
migration's decision, but without a list endpoint the operator has to copy
every technician's target user id into `mapping.json` by hand. A technician
left unmapped is dropped from every visit they worked.

**Needed:** `GET /v1/people` (id, name, email, active) so `map` can match by
email and propose the mapping, and ideally a way to record a historical,
non-login person so a technician who left in 2019 can still be on their
visits.

### `job.job_type`

`jobTypeId` must be a target id and no route lists or creates job types.

**Needed:** `GET /v1/job-types`.

## Work

### `visit.cancelled`

No route records a visit as cancelled. Loading one as scheduled would send
a technician to a customer who declined, so cancelled visits are not loaded.

**Needed:** a `status` on `POST /v1/jobs/{id}/visits` for historical
visits, or a cancel route.

### `visit.unscheduled`

`POST /v1/jobs/{id}/visits` and the inline `visit` on `POST /v1/jobs`
require both `windowStart` and `windowEnd`. A source visit with no time
cannot exist. A visit with a start and no end loads with a zero-length window
rather than an invented hour.

### `visit.idempotency`: declared idempotent, not idempotent

`scheduleVisit` is declared `idempotent: true` in the contract, but
`services/jobs.ts addVisit` never reads the Idempotency-Key, so a retried
call adds a second visit. Nothing is lost: the loader reads the job back and
adopts a visit already there at the same window before adding one. It costs
a GET per resumed job, and any other client retrying this route makes
duplicates.

**Needed:** honour the key in `addVisit`, as every create does.

### `job.completed_at`

`PATCH /v1/jobs/{id}` with `status: "completed"` stamps `completedAt` as
now. Where the job has completed visits, the loader completes them through
`POST /v1/visits/{id}/complete` with `completedOfflineAt` set to the source's
completion time, which carries the real date. A job completed with no
completed visit gets today.

**Needed:** an optional `completedAt` on the status update.

## Estimates

### `estimate.status`

An approved, sent or converted estimate loads as a draft.
`POST /v1/estimates/{id}/approve` exists but requires a signer name and
`capturedVia` (in person, phone, email, text), and inventing how a customer
said yes years ago would fabricate a record. Declined estimates are recorded
through `POST /v1/estimates/{id}/decline`.

**Needed:** a historical status (with its date) on create for import.

### `estimate.dates` and `estimate.tax`

No issued or sent date on create, and one `taxRate` for the whole estimate
with tax recomputed from it. Deriving a rate from the source's tax amount
would be recomputing what the source recorded, so it is not done.

## Customers and properties

### `customer.notes`

`POST /v1/customers` has no notes field. Free-text notes are not carried.

### `customer.billing_incomplete` and `customer.contact_invalid`

`billingAddress` is all-or-nothing (line1, city, state, postal code), and an
email must be a valid address. Rather than lose the customer, the loader
leaves the field off and reports it.

### `property.coordinates`

`POST /v1/properties` has no latitude or longitude. Source geocodes are not
carried; the target must geocode again.

### `pricebook.code`

`POST /v1/pricebook/items` requires `code`. An item with none gets one
derived from its name and source id (stable across runs).

## Attachments

### `attachments.upload`

There is no route a third party can use to upload a file and attach it to a
record. The only upload path, `POST /v1/field/uploads/{clientId}`, accepts
bytes for an upload a registered field device has already queued; driving it
from a migration would mean impersonating a phone. `attachments` therefore
downloads every file locally, hashes it, and writes an index naming the
target record each belongs to, ready for the day this exists.

**Needed:** `POST /v1/attachments` taking `entityType`, `entityId`,
`fileName` and base64 bytes (the same encoding the field route uses), with an
Idempotency-Key.

## Checked, and not a gap

- **Idempotency keys are tenant scoped.** The services look keys up in
  `integration_event` without an `organization_id` filter, which reads like a
  cross-tenant leak. It is not: every table with an `organization_id` has row
  level security (`db/sql/after.sql`), and services run inside `inTenant`,
  which sets `app.organization_id`.
- **Job status cannot be set freely.** It is walked through the lifecycle the
  service enforces (`REACHABLE` in `services/jobs.ts`), and the loader never
  walks a job backwards.
- **A property shared by several customers** is supported:
  `POST /v1/properties/{id}/customers` links the second and later ones, and is
  naturally idempotent.
