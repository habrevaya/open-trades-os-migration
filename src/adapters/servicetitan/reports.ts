/**
 * SERVICETITAN, FROM THE OWNER'S OWN REPORTS
 *
 * The default ServiceTitan route. The owner runs reports in their own
 * ServiceTitan account, exports each one, and puts the files in a folder.
 * This is Generic CSV with ServiceTitan's columns built in, the same pattern
 * as FieldEdge. Nothing here connects to ServiceTitan or holds a ServiceTitan
 * credential. (The canonical snapshot importer, `--format canonical`, is
 * still there for an owner who produces one by other means.)
 *
 * Sources, all ServiceTitan's own help center, read 2026-10-01:
 *
 *   Exporting: Reports > open a report > Export > "Export to XLSX".
 *     https://help.servicetitan.com/docs/run-report.md
 *   Custom reports: Reports > Create Report > pick a template > tick columns.
 *     Works package or Legacy/Non-Packaged only; Starter and Essentials get
 *     built-in reports. https://help.servicetitan.com/docs/create-custom-reports.md
 *     and https://help.servicetitan.com/docs/invoices-report-template.md
 *   The id columns every template shares, by name (Customer ID, Location ID,
 *     Job ID, Invoice ID, and Estimates' Parent Job ID): "Joins through data
 *     fields for multi-template reports",
 *     https://help.servicetitan.com/docs/create-and-run-multi-template-reports.md
 *   Customer List (built-in, every package): Customer ID, Customer Name,
 *     Type, Phone Number, Email, Full Address, Do Not Mail, Do Not Service,
 *     Customer Tags. https://help.servicetitan.com/docs/customer-list-report.md
 *   Templates and their documented columns:
 *     Customers      https://help.servicetitan.com/docs/customers-report-template.md
 *     Locations      https://help.servicetitan.com/docs/locations-report-template.md
 *     Jobs           https://help.servicetitan.com/docs/jobs-report-template.md
 *     Invoices       https://help.servicetitan.com/docs/invoices-report-template.md
 *     Invoice Items  https://help.servicetitan.com/docs/invoice-items-report-template.md
 *     Applied Payments https://help.servicetitan.com/docs/applied-payments-report-template.md
 *     Estimates      https://help.servicetitan.com/docs/estimates-report-template.md
 *     Equipment      https://help.servicetitan.com/docs/equipment-report-template.md
 *     Customer Memberships https://help.servicetitan.com/docs/customer-memberships-report-template.md
 *     Technician Performance https://help.servicetitan.com/docs/technician-performance-report-template.md
 *   Pricebook: Pricebook > Import/Export > Export tab > "Pricebook (Settings,
 *     Materials and Part Link)", an XLSX with Services, Materials and
 *     Equipment sheets whose columns are listed in
 *     https://help.servicetitan.com/docs/pricebook-excel-template.md and
 *     https://help.servicetitan.com/docs/import-and-export-your-pricebook.md
 *
 * VERIFIED AND ASSUMED. Every header below is marked. "Documented" means the
 * page above names it as a column of that report. "Assumed" means the help
 * center names the data (a template's "Invoice Totals" section, say) but not
 * the header, and the header here is our best reading of ServiceTitan's
 * naming. An assumed header that is not in the file maps nothing: the value
 * is simply absent, and profile's fill rates show it. An operator who finds
 * the real header writes it in columns.json beside the exports, which is
 * laid over this preset one column at a time.
 *
 * Joins are on ServiceTitan's own ids, which every one of these reports can
 * carry, so unlike FieldEdge nothing is joined by name except technicians,
 * which no report gives an id for.
 */
import { createCsvAdapter, type ColumnConfig } from "../csv/index.js";
import type { SourceAdapter, SourceCapabilities } from "../types.js";

export const SERVICETITAN_COLUMNS: ColumnConfig = {
  files: {
    customers: {
      // Customer List (built-in) or a Customers-template report. Both
      // documented; their only difference here is Type / Customer Type.
      file: "Customers*.xlsx",
      columns: {
        id: "Customer ID",                          // documented
        name: "Customer Name",                      // documented
        type: ["Type", "Customer Type"],            // Type documented (Customer List); Customer Type assumed (Customers template)
        phone: "Phone Number",                      // documented
        email: "Email",                             // documented
        billing_address: "Full Address",            // documented: "Billing address"
        "custom:Tags": "Customer Tags",             // documented
        "custom:Do not mail": "Do Not Mail",        // documented
        "custom:Do not service": "Do Not Service",  // documented
      },
    },
    properties: {
      file: "Locations*.xlsx",
      columns: {
        id: "Location ID",                          // documented
        customer_id: "Customer ID",                 // documented (join field)
        nickname: "Location Name",                  // documented
        address: "Location Address",                // documented by name; one line
        "custom:Location phone": "Location Phone",  // documented by name
      },
    },
    jobs: {
      file: "Jobs*.xlsx",
      columns: {
        id: "Job ID",                               // documented (join field)
        number: "Job #",                            // documented
        customer_id: "Customer ID",                 // documented (join field)
        property_id: "Location ID",                 // documented (join field)
        job_type: "Job Type",                       // documented
        lead_source: "Job Campaign",                // documented
        total: "Total",                             // documented: total on the invoice
        completed_at: "Completion Date",            // documented
        status: "Job Status",                       // assumed (named as a column of Applied Payments)
        summary: "Job Summary",                     // assumed
        visit_start: ["Job Start Date", "Scheduled Date"], // assumed
        technician_ids: "Primary Technician",       // assumed (named as a column of Applied Payments)
        "custom:Business unit": "Business Unit",    // documented
        "custom:Campaign category": "Campaign Category", // documented
        "custom:Invoice #": "Invoice #",            // documented
      },
    },
    invoices: {
      file: "Invoices*.xlsx",
      columns: {
        id: "Invoice ID",                           // documented (join field)
        number: "Invoice #",                        // documented
        job_id: "Job ID",                           // documented (join field)
        customer_id: "Customer ID",                 // documented (join field)
        status: "Invoice Status",                   // documented: Pending, Batched, Posted, Exported
        total: "Total",                             // documented
        balance: "Balance",                         // documented
        issued_on: "Invoice Date",                  // documented
        subtotal: "Subtotal",                       // assumed ("Invoice Totals" section)
        tax_total: ["Tax", "Sales Tax"],            // assumed ("Invoice Totals" section)
        due_on: "Due Date",                         // assumed ("Invoice Dates" section)
      },
    },
    invoice_lines: {
      file: "Invoice Items*.xlsx",
      columns: {
        invoice_id: "Invoice ID",                   // documented (join field)
        name: "Item Name",                          // documented
        line_total: "Item Price",                   // documented: "total price on the invoice for all quantities"
        quantity: ["Quantity", "Item Quantity"],    // assumed ("Invoice Item Details" section)
        description: "Item Description",            // assumed
        taxable: "Taxable",                         // assumed
        "custom:Item code": "Item Code",            // documented; kept in the raw row
      },
    },
    payments: {
      // Applied Payments: one row per payment applied to an invoice.
      file: "Applied Payments*.xlsx",
      columns: {
        customer_id: "Customer ID",                 // documented (join field)
        invoice_id: "Invoice ID",                   // documented (join field)
        amount: "Amount",                           // documented: "The amount of the payment"
        method: "Payment Method",                   // documented: Credit Card, Bank Account (ACH), Check, Cash
        received_at: "Paid On",                     // documented by name ("Dates" section)
        reference: "Payment ID",                    // assumed here (documented on All Payments)
      },
    },
    estimates: {
      file: "Estimates*.xlsx",
      columns: {
        id: "Estimate Id",                          // documented
        title: "Estimate Name",                     // documented
        job_id: "Parent Job ID",                    // documented (join field)
        customer_id: "Customer ID",                 // documented (join field)
        property_id: "Location ID",                 // documented (join field)
        status: "Estimate Status",                  // documented: Sold, Dismissed, Open
        subtotal: "Subtotal",                       // documented
        tax_total: "Tax",                           // assumed ("Estimate Totals" section)
        total: "Total",                             // assumed
        issued_on: ["Creation Date", "Created On"], // assumed ("Estimate Dates" section)
      },
    },
    equipment: {
      file: "Equipment*.xlsx",
      columns: {
        property_id: "Location ID",                 // documented (join field)
        category: "Equipment Type",                 // documented
        name: "Equipment name",                     // documented
        manufacturer: "Manufacturer",               // documented
        model: "Model",                             // documented
        serial_number: "Serial Number",             // documented
        installed_on: "Installed On",               // documented by name ("Dates" section)
        "custom:Equipment code": "Equipment Code",  // documented
        "custom:Memo": "Memo",                      // documented
        "custom:Cost": "Cost",                      // documented
      },
    },
    recurring_schedules: {
      // Customer Memberships: one row per membership.
      file: "Memberships*.xlsx",
      columns: {
        id: "Membership ID",                        // documented by name ("Customer Memberships Basics")
        customer_id: "Customer ID",                 // documented (join field)
        property_id: "Location ID",                 // documented by name ("Member Pricing Location")
        name: "Membership Type",                    // documented
        status: "Membership Status",                // documented: Active, Suspended, Canceled, Expired, Deleted
        starts_on: "From",                          // documented: date the membership started
        ends_on: "To",                              // documented: expiration, blank when ongoing
        "custom:Next billing date": "Next Billing Date", // documented
        "custom:Sold by": "Sold By",                // documented
        "custom:Activation method": "Activation Method", // documented
      },
      // ServiceTitan generates each membership's visits as recurring service
      // events (a materialized series). The membership report does not carry
      // them, so the schedule arrives without a rule and is reported, not
      // invented. See docs/servicetitan.md.
      defaults: { kind: "service-agreement", model: "materialized-series" },
    },
    users: {
      // Technician Performance: one row per technician. No id column is
      // documented; jobs name technicians, so the name is the id.
      file: "Technicians*.xlsx",
      columns: {
        id: "Name",                                 // documented
        name: "Name",                               // documented
      },
      defaults: { role: "technician" },
    },
    price_book: {
      file: "Pricebook*.xlsx",
      sheet: ["Services", "Materials", "Equipment"],
      columns: {
        id: "ID",                                   // documented (Services spells it Id; matched either way)
        kind: "_sheet",                             // the sheet the row is on
        code: "Code",                               // documented
        name: "Name",                               // documented
        description: ["Item Description", "Description"], // documented (Services / Materials, Equipment)
        price: "Price",                             // documented
        cost: "Cost",                               // documented (Materials, Equipment)
        taxable: "Taxable",                         // documented
        active: "Active",                           // documented
      },
    },
  },
};

export const capabilities: SourceCapabilities = {
  entities: ["user", "customer", "property", "priceBookItem", "equipment", "estimate", "job", "recurringSchedule", "invoice", "payment"],
  hasApi: false,
  hasAttachments: false,
  recurrenceModel: "materialized-series",
  knownLimits: [
    "This is THE ServiceTitan route: reports you export yourself from your own ServiceTitan account (Reports > Export > XLSX), dropped in one folder. Connects to nothing. See docs/servicetitan.md.",
    "Records are joined on ServiceTitan's own Customer ID, Location ID, Job ID and Invoice ID columns. Add them to each report; profile reports every invoice, job, estimate, payment or location whose id is not in the other files.",
    "Custom reports (everything but Customer List and the pricebook) need ServiceTitan's Works package or a Legacy/Non-Packaged account. On Starter or Essentials you can export customers and the pricebook only.",
    "Run Jobs, Invoices, Invoice Items, Applied Payments and Estimates over the same full date range. A big account can export a year per file: Invoices 2019.xlsx, Invoices 2020.xlsx, ... are all read.",
    "Pass --timezone with your ServiceTitan account's time zone, so a 9:00 appointment stays 9:00 your time.",
    "Some headers are assumed, not documented (marked in src/adapters/servicetitan/reports.ts and docs/servicetitan.md). An assumed header missing from your file maps nothing; fix it in columns.json.",
    "A Job # or Invoice # that is not a whole number makes that row unreadable, by id, in profile. Unmap number in columns.json if your numbers carry letters.",
  ],
  unsupported: [
    { field: "payments not applied to an invoice", reason: "Applied Payments lists only applied payments. Deposits and unapplied credit (All Payments' Credit Remaining) carry no Customer ID in the documentation, so they are not imported." },
    { field: "Applied Payments Amount", reason: "Documented as \"the amount of the payment\". If a payment split across two invoices shows its whole amount on both rows, profile's invoice.payments_do_not_match_balance says so." },
    { field: "appointments, visits beyond the first", reason: "The Jobs report is one row per job. Each job carries at most one visit, from its start date if your report has one." },
    { field: "recurring service events", reason: "Memberships arrive as service agreements with their type, dates and status, without the visits ServiceTitan generated for them or how often they recur. profile flags each active one with no next visit; check its schedule in OpenTradesOS after loading." },
    { field: "equipment warranty dates", reason: "The Equipment template's warranty columns are not named in its documentation. Map them in columns.json once you see your file." },
    { field: "invoice lines linked to the price book", reason: "Invoice Items gives the item's code, the pricebook export its ID; lines are carried as charged, not linked." },
    { field: "contacts, attachments, call recordings, forms, tags as tags", reason: "Not in these reports. Customer Tags is carried as a custom field." },
  ],
};

export const servicetitanReports: SourceAdapter = createCsvAdapter({
  id: "servicetitan-csv",
  displayName: "ServiceTitan (reports)",
  sourceSystem: "servicetitan",
  preset: SERVICETITAN_COLUMNS,
  capabilities,
});
