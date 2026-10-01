/**
 * WHAT THE TARGET API CANNOT YET TAKE, AND WHAT IT NOW CAN
 *
 * Every place where the source has a fact and OpenTradesOS's public API had,
 * or has, no way to receive it. The loader does not fake any of these: it
 * loads what the API accepts, and each record that loses something here is
 * counted against the gap that lost it, so the report says "38 invoices lost
 * their tax" rather than nothing.
 *
 * A gap the core has since closed stays in this list, marked `closed` with
 * what closed it, so a report from an older run still explains itself and so
 * the history of what a migration used to lose is not lost too. The loader
 * never counts a record against a closed gap.
 *
 * This list and docs/target-api-gaps.md are the same list. The doc is the
 * argument for each change in the core; this is what the report prints.
 */

export type GapStatus = "open" | "partly" | "closed";

export interface Gap {
  /** The endpoint or field involved. */
  where: string;
  /** What is lost, in one sentence. */
  lost: string;
  status: GapStatus;
  /** For a closed or partly closed gap: what the core does now, and since when. */
  now?: string;
}

export const GAPS = {
  "external-id": {
    where: "every create (POST /v1/customers, /v1/properties, /v1/jobs, /v1/invoices, ...)",
    lost: "No field carried the source system and source id, so the target could not be asked which record a source id became.",
    status: "closed",
    now: "externalRef { source, id } on every importable create, unique per kind, a 409 naming the record on a repeat, filterable on every list (ca51de1). Sent on every create; a lost ledger is rebuilt from it.",
  },
  "user.create": {
    where: "GET /v1/people lists; no route creates a person",
    lost: "A technician with no account in the target cannot be created, so their visits name nobody.",
    status: "partly",
    now: "GET /v1/people lists everyone with their technician id (6d06c0f), and map proposes each match by email or name. Creating a login is still not a migration's decision, and a person who never had one cannot be recorded.",
  },
  "user.unmapped": {
    where: "mapping.json users",
    lost: "A technician with no target technician was dropped from a visit they worked.",
    status: "partly",
    now: "map proposes a technician for every source user it can match in GET /v1/people; the rest are the operator's to decide.",
  },
  "customer.notes": {
    where: "POST /v1/customers has no notes field",
    lost: "Free text notes on the customer are not carried.",
    status: "open",
  },
  "customer.billing_incomplete": {
    where: "POST /v1/customers billingAddress requires line1, city, state and postalCode together",
    lost: "A partial billing address (a city with no street) cannot be stored at all, so it was left off.",
    status: "open",
  },
  "customer.contact_invalid": {
    where: "POST /v1/customers email must be an address, phone at most 40 characters",
    lost: "An email or phone the target refuses was left off rather than failing the whole customer.",
    status: "open",
  },
  "contact.create": {
    where: "no route creates a contact (a job's parties can name one, nothing makes one)",
    lost: "People at a customer other than the customer (a tenant, a property manager, an accounts payable clerk) are not loaded.",
    status: "open",
  },
  "property.coordinates": {
    where: "POST /v1/properties has no latitude/longitude",
    lost: "Geocodes from the source are not carried; the target must geocode again.",
    status: "open",
  },
  "equipment.create": {
    where: "no route creates customer equipment (/v1/assets is the company's own kit, not the customer's furnace)",
    lost: "Equipment at a property, with its serial and warranty dates, is not loaded.",
    status: "open",
  },
  "pricebook.code": {
    where: "POST /v1/pricebook/items requires code",
    lost: "The source item has no code, so one was derived from its name and source id.",
    status: "open",
  },
  "job.number": {
    where: "POST /v1/jobs number",
    lost: "The source job number was replaced by the target's next number.",
    status: "closed",
    now: "number on create, with data:import, refused if taken (ca51de1). Sent.",
  },
  "job.completed_at": {
    where: "PATCH /v1/jobs/{id} completedAt",
    lost: "A job completed with no completed visit to carry the time got today as its completion date.",
    status: "closed",
    now: "completedAt with the move to completed, more than a week back with data:import (cfa5dc8). Sent.",
  },
  "job.job_type": {
    where: "GET /v1/job-types lists; no route creates one",
    lost: "A job type with no target id in mapping.json was left off the job.",
    status: "partly",
    now: "GET /v1/job-types lists them (6d06c0f) and map proposes a match by name or code. A type the target does not have must be made there first.",
  },
  "visit.cancelled": {
    where: "POST /v1/jobs/{id}/visits status",
    lost: "Cancelled visits were not loaded, because loading one as scheduled would send a technician.",
    status: "closed",
    now: "status: \"cancelled\" records the visit and dispatches nobody (19c6140). Sent.",
  },
  "visit.unscheduled": {
    where: "POST /v1/jobs/{id}/visits window",
    lost: "A visit with no time on it could not exist in the target.",
    status: "closed",
    now: "The window is both ends or neither; neither is an untimed visit kept unassigned (19c6140). Sent without one.",
  },
  "visit.idempotency": {
    where: "POST /v1/jobs/{id}/visits Idempotency-Key",
    lost: "Nothing was lost: the loader read the job back before re-adding a visit, at a GET per resumed job.",
    status: "closed",
    now: "addVisit honours the key (0a77904), and visits take an externalRef. The read-back is only for adopting what a lost ledger forgot.",
  },
  "estimate.number": {
    where: "POST /v1/estimates number",
    lost: "The source estimate number was replaced by the target's.",
    status: "closed",
    now: "number on create, with data:import (ca51de1). Sent.",
  },
  "estimate.status": {
    where: "no route records a historical approval without fabricating how the customer said yes",
    lost: "Approved, converted or sent estimates load as drafts.",
    status: "open",
  },
  "estimate.dates": {
    where: "POST /v1/estimates issuedOn",
    lost: "When the estimate was written was not carried.",
    status: "partly",
    now: "issuedOn on create (cfa5dc8), sent. When it was sent, viewed or decided still cannot be.",
  },
  "estimate.tax": {
    where: "POST /v1/estimates takes rates (per estimate, per line) and no stated tax amount",
    lost: "No single rate on the estimate's taxable lines reproduces the source's tax to the cent, so it loaded without tax.",
    status: "partly",
    now: "Per-line taxRate (4745ce4). The loader sends the rate that reproduces the source's tax under the target's arithmetic; only an estimate no rate reproduces loses it.",
  },
  "estimate.reprice": {
    where: "POST /v1/estimates re-prices a line linked to the price book, with no priceAsGiven",
    lost: "Estimate lines are not linked to price book items, because linking them would re-price them at today's price.",
    status: "open",
  },
  "invoice.number": {
    where: "POST /v1/invoices number",
    lost: "The source invoice number was replaced by the target's.",
    status: "closed",
    now: "number on create, with data:import, refused if taken (ca51de1). Sent.",
  },
  "document.number_taken": {
    where: "POST /v1/jobs, /v1/estimates and /v1/invoices refuse a number already in use",
    lost: "The target already had a document with the source's number, so this one took the next number instead.",
    status: "open",
  },
  "invoice.issued_on": {
    where: "POST /v1/invoices issuedOn",
    lost: "The historical issue date was replaced by the load date, which skewed AR aging.",
    status: "closed",
    now: "issuedOn on create, and the posting dated by it, with data:import more than a week back (cfa5dc8). Sent.",
  },
  "invoice.tax": {
    where: "POST /v1/invoices lines[].taxRate and taxAmount, within a cent of the rate",
    lost: "The source's tax could not be stated on any of its lines within a cent (it charged tax on lines it calls untaxable, or on nothing), so the target total is short by the tax.",
    status: "partly",
    now: "Tax as charged per line, with data:import (4745ce4). Sent for every invoice whose tax sits on a taxable line; --carry-totals carries the rest in the adjustment.",
  },
  "invoice.totals": {
    where: "POST /v1/invoices adjustment and expectedTotals",
    lost: "An invoice whose lines do not add up to its subtotal loaded at a different total.",
    status: "closed",
    now: "One invoice-level adjustment, and expectedTotals refusing any total off by a cent (4745ce4). The loader sends the difference as the adjustment and the source's totals as the cross check.",
  },
  "invoice.reprice": {
    where: "POST /v1/invoices lines[].priceAsGiven",
    lost: "Historical lines were not linked to price book items, because linking them would re-price them.",
    status: "closed",
    now: "priceAsGiven keeps the line as charged and links the item, with data:import (4745ce4). Sent.",
  },
  "invoice.item_unlinked": {
    where: "the line's price book item is not in the target",
    lost: "A line names a price book item that did not load, so it is not linked to one.",
    status: "open",
  },
  "ledger.dates": {
    where: "POST /v1/invoices and POST /v1/payments postings",
    lost: "Historical revenue and cash landed in the load's accounting period.",
    status: "closed",
    now: "Postings dated by issuedOn and receivedAt (cfa5dc8).",
  },
  "history.future": {
    where: "every business date: the target refuses one in the future",
    lost: "A date after today (a post-dated invoice or cheque) was left off, so the target used today.",
    status: "open",
  },
  "payment.unapplied": {
    where: "POST /v1/payments allocations: []",
    lost: "A deposit or account credit could not be recorded as unapplied money, so it was not loaded.",
    status: "closed",
    now: "An empty allocation list holds the money for the customer as unappliedAmount (eec32cf). Sent.",
  },
  "payment.refund": {
    where: "POST /v1/payments/{id}/refunds",
    lost: "A refund in the source was not loaded: it does not say which payment it gave back, and exactly one loaded payment could not be found that it must be.",
    status: "partly",
    now: "A refund paid by hand is recorded against its payment (19c6140). Loaded wherever one payment of the customer can be the one refunded.",
  },
  "attachments.upload": {
    where: "POST /v1/attachments",
    lost: "Photos and documents were downloaded locally and could not be attached in the target.",
    status: "closed",
    now: "POST /v1/attachments takes base64 bytes for a customer, property, job, visit, estimate or invoice (32130f0). attachments --target uploads them.",
  },
  "attachments.unattachable": {
    where: "POST /v1/attachments: six kinds of record, twenty megabytes, PNG, JPEG, GIF, WebP, ICO, HEIC and PDF",
    lost: "A file on equipment, over twenty megabytes, or of another type (a Word document, a video) stays in the local folder.",
    status: "open",
  },
  "read.payments": {
    where: "GET /v1/payments",
    lost: "Reconcile could not read payments back.",
    status: "closed",
    now: "GET /v1/payments with allocations and unappliedAmount (6d06c0f). Reconcile reads them.",
  },
  "recurring.inactive": {
    where: "POST /v1/recurring-schedules creates a running schedule; there is no way to create one ended",
    lost: "An ended, cancelled or paused schedule is not loaded; its history is the jobs it produced, which are.",
    status: "open",
  },
  "recurring.rule": {
    where: "POST /v1/recurring-schedules repeats by days or by months of the year",
    lost: "A rule the target cannot repeat (every 5 months, the second Tuesday, months counted from completion) is not loaded.",
    status: "open",
  },
  "recurring.anchor_day": {
    where: "POST /v1/recurring-schedules has no day of the month for anchor months",
    lost: "Occurrences pinned to months land on the 15th, not the source's day.",
    status: "open",
  },
  "recurring.occurrences": {
    where: "no route says a job is an occurrence of a schedule",
    lost: "Jobs the source booked from a schedule load as jobs, not linked to it; a repeating schedule with any is created paused so it does not book them again.",
    status: "open",
  },
  "recurring.agreement_terms": {
    where: "POST /v1/recurring-schedules has no price, billing frequency or visits per term",
    lost: "What a service agreement costs and how it bills is not carried; only its schedule is.",
    status: "open",
  },
  "recurring.assignment": {
    where: "POST /v1/recurring-schedules names no technician or equipment",
    lost: "Who a schedule's work goes to, and which equipment it services, is not carried.",
    status: "open",
  },
} as const satisfies Record<string, Gap>;

export type GapCode = keyof typeof GAPS;

/** The gaps a loader can still count a record against. */
export const OPEN_GAPS = (Object.keys(GAPS) as GapCode[]).filter((code) => GAPS[code].status !== "closed");
