/**
 * WHAT THE TARGET API CANNOT YET TAKE
 *
 * Every place where the source has a fact and OpenTradesOS's public API has
 * no way to receive it. The loader does not fake any of these: it loads what
 * the API accepts, and each record that loses something here is counted
 * against the gap that lost it, so the report says "38 invoices lost their
 * historical issue date" rather than nothing.
 *
 * This list and docs/target-api-gaps.md are the same list. The doc is the
 * argument for each change in the core; this is what the report prints.
 */

export interface Gap {
  /** The endpoint or field that would close it. */
  where: string;
  /** What is lost, in one sentence. */
  lost: string;
}

export const GAPS = {
  "external-id": {
    where: "every create (POST /v1/customers, /v1/properties, /v1/jobs, /v1/invoices, ...)",
    lost: "No field carries the source system and source id, so the target cannot be asked which record a source id became; the local ledger is the only map.",
  },
  "user.create": {
    where: "no route creates, invites or lists users or memberships",
    lost: "Technicians cannot be created or looked up through the API; each one must be mapped to an existing target user by hand in mapping.json.",
  },
  "user.unmapped": {
    where: "mapping.json users (no API to list target users)",
    lost: "A technician with no target user was dropped from a visit they worked.",
  },
  "customer.notes": {
    where: "POST /v1/customers has no notes field",
    lost: "Free text notes on the customer are not carried.",
  },
  "customer.billing_incomplete": {
    where: "POST /v1/customers billingAddress requires line1, city, state and postalCode together",
    lost: "A partial billing address (a city with no street) cannot be stored at all, so it was left off.",
  },
  "customer.contact_invalid": {
    where: "POST /v1/customers email must be an address, phone at most 40 characters",
    lost: "An email or phone the target refuses was left off rather than failing the whole customer.",
  },
  "property.coordinates": {
    where: "POST /v1/properties has no latitude/longitude",
    lost: "Geocodes from the source are not carried; the target must geocode again.",
  },
  "pricebook.code": {
    where: "POST /v1/pricebook/items requires code",
    lost: "The source item has no code, so one was derived from its name and source id.",
  },
  "job.number": {
    where: "POST /v1/jobs has no number",
    lost: "The source job number is replaced by the target's next number.",
  },
  "job.completed_at": {
    where: "PATCH /v1/jobs/{id} stamps completedAt as now",
    lost: "A job completed with no completed visit to carry the time gets today as its completion date.",
  },
  "job.job_type": {
    where: "no route lists or creates job types; jobTypeId must be a target id",
    lost: "A job type with no target id in mapping.json was left off the job.",
  },
  "visit.cancelled": {
    where: "no route records a visit as cancelled",
    lost: "Cancelled visits are not loaded, because loading one as scheduled would send a technician.",
  },
  "visit.unscheduled": {
    where: "POST /v1/jobs/{id}/visits requires windowStart and windowEnd",
    lost: "A visit with no time on it cannot exist in the target.",
  },
  "visit.idempotency": {
    where: "POST /v1/jobs/{id}/visits is declared idempotent and its service ignores Idempotency-Key",
    lost: "Nothing is lost: the loader reads the job back before re-adding a visit. It costs a GET per resumed job.",
  },
  "estimate.number": {
    where: "POST /v1/estimates has no number",
    lost: "The source estimate number is replaced by the target's.",
  },
  "estimate.status": {
    where: "no route records a historical approval without fabricating how the customer said yes",
    lost: "Approved, converted or sent estimates load as drafts.",
  },
  "estimate.dates": {
    where: "POST /v1/estimates has no issued or sent date",
    lost: "When the estimate was written is not carried.",
  },
  "estimate.tax": {
    where: "POST /v1/estimates takes one taxRate and recomputes tax",
    lost: "Tax as applied on the source estimate is not carried.",
  },
  "invoice.number": {
    where: "POST /v1/invoices has no number",
    lost: "The source invoice number is replaced by the target's (it is kept in the memo).",
  },
  "invoice.issued_on": {
    where: "POST /v1/invoices stamps issuedOn as today",
    lost: "The historical issue date is replaced by the load date (it is kept in the memo), which skews AR aging.",
  },
  "invoice.tax": {
    where: "POST /v1/invoices fixes taxRate at 0 per line and ignores client totals",
    lost: "Tax as applied on the source invoice is not carried, so the target total is short by the tax.",
  },
  "invoice.totals": {
    where: "POST /v1/invoices computes totals from lines and ignores client totals",
    lost: "The source's lines do not add up to its subtotal (truncated lines, an invoice-level discount or adjustment), so the target total differs.",
  },
  "invoice.reprice": {
    where: "POST /v1/invoices replaces a line's price with the price book's CURRENT version when priceBookItemId is given",
    lost: "Historical lines are not linked to price book items, because linking them would re-price them at today's price.",
  },
  "ledger.dates": {
    where: "POST /v1/invoices and POST /v1/payments post to the ledger dated now",
    lost: "Historical revenue and cash land in the load's accounting period, not the period they happened in.",
  },
  "payment.unapplied": {
    where: "POST /v1/payments applies oldest balance first when allocations is empty",
    lost: "A deposit or account credit cannot be recorded as unapplied money, so it was not loaded.",
  },
  "payment.refund": {
    where: "no route records a historical refund",
    lost: "A negative payment or refund in the source was not loaded.",
  },
  "attachments.upload": {
    where: "no route uploads a file and attaches it to a record (only the field device queue, /v1/field/uploads)",
    lost: "Photos and documents are downloaded locally and cannot be attached in the target.",
  },
  "read.payments": {
    where: "no GET /v1/payments",
    lost: "Reconcile cannot read payments back; it uses the amounts the target confirmed at write time.",
  },
} as const satisfies Record<string, Gap>;

export type GapCode = keyof typeof GAPS;
