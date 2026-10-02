/**
 * FIELDEDGE
 *
 * FieldEdge has no public API, so this is Generic CSV with the columns of
 * FieldEdge's own exports built in. The reports, where to find them and
 * their exact columns are as documented in "Export your FieldEdge data",
 * https://help.servicetitan.com/how-to/import-fe (read 2026-10-01): five
 * exports a FieldEdge owner runs from their own account.
 *
 *   Customers tab, Export                          CustomerList.xlsx
 *   Dispatching tab, Export                        DispatchList.xlsx
 *   Invoices tab, every filter set to All, Export  InvoiceList.xlsx
 *   Quotes tab, Export                             QuoteList.xlsx
 *   Reports > Customer Reports > Equipment List    EquipmentList.xlsx
 *
 * Each is saved from Excel as CSV beside the others, keeping its name. See
 * docs/fieldedge.md.
 *
 * None of the exports carries a record id. Customers are joined across the
 * five files by the customer's name, which is the only key they share, and
 * the documentation does not say that the Customer column of the other four
 * reports is the Name column of the first. `profile` checks it: a job,
 * invoice or quote whose customer does not match turns up as an orphan.
 *
 * Where a column's meaning is not documented it is carried as a custom
 * field or left in the raw row, never mapped onto a canonical field it might
 * not mean. The operator's own columns.json is laid over this preset, so
 * mapping one of those columns after looking at a real export is one line.
 */
import { createCsvAdapter, type ColumnConfig } from "../csv/index.js";
import type { SourceAdapter, SourceCapabilities } from "../types.js";

export const FIELDEDGE_COLUMNS: ColumnConfig = {
  files: {
    customers: {
      file: "CustomerList.csv",
      columns: {
        id: "Name", name: "Name", email: "Email", phone: "Phone",
        billing_line1: "Address 1", billing_line2: "Address 2", billing_city: "City",
        billing_state: "State", billing_postal_code: "Zip",
        "custom:Active": "Active", "custom:Company": "Company", "custom:Full name": "Full Name",
      },
    },
    properties: {
      file: "CustomerList.csv",
      columns: {
        id: "Name", customer_id: "Name",
        line1: "Address 1", line2: "Address 2", city: "City", state: "State", postal_code: "Zip",
      },
    },
    jobs: {
      file: "DispatchList.csv",
      columns: {
        id: "WO#", customer_id: "Customer", property_id: "Customer",
        status: "Status", summary: "Task (Duration)", lead_source: "Lead Source",
        visit_start: "Schedule Date/Time", technician_ids: "Tech", visit_status: "Status",
        "custom:PO#": "PO#", "custom:Promised appointment": "Promised Appointment",
        "custom:Arrival": "Arrival", "custom:Complete": "Complete",
        "custom:Priority": "Priority", "custom:Est complete": "Est Complete",
      },
    },
    invoices: {
      file: "InvoiceList.csv",
      columns: {
        id: "Invoice #", customer_id: "Customer", job_id: "WO #",
        issued_on: "Date", due_on: "Due Date", total: "Total", balance: "Due",
      },
    },
    estimates: {
      file: "QuoteList.csv",
      columns: {
        id: "Quote #", customer_id: "Customer", property_id: "Customer",
        status: "Status", issued_on: "Date", expires_on: "Expiration", total: "Amount", title: "Task",
      },
    },
    equipment: {
      file: "EquipmentList.csv",
      columns: {
        property_id: "Customer", name: "Equip. Name", category: "Equip. Type",
        manufacturer: "Manufacturer", model: "Model", serial_number: "Serial #", installed_on: "Install",
        "custom:Parts warranty": "Parts Warranty", "custom:Labor warranty": "Labor Warranty",
        "custom:Replace date": "Replace Date",
      },
    },
  },
};

export const capabilities: SourceCapabilities = {
  entities: ["customer", "property", "equipment", "estimate", "job", "invoice"],
  hasApi: false,
  hasAttachments: false,
  recurrenceModel: "manual-list",
  knownLimits: [
    "Reads FieldEdge's own exports, saved as CSV: CustomerList, DispatchList, InvoiceList, QuoteList and EquipmentList. Run each from your own FieldEdge account; see docs/fieldedge.md.",
    "No export carries an id. Customers are joined across files by name, so two customers with the same name merge, and a name spelled differently in two reports shows up in profile as an orphan.",
    "One property per customer, from the Customer List address. Jobs, quotes and equipment are placed at it; a second service address is not in any export's key.",
    "Set every filter on the Invoices tab to All before exporting, or FieldEdge exports only the last six months.",
    "Each dispatch row is read as one job with one visit. A work order dispatched twice appears twice under the same WO#, which profile reports as a duplicate id.",
  ],
  unsupported: [
    { field: "payments", reason: "No documented export lists payments. The Due column carries what is still owed, but an invoice loaded without its payments shows its paid part as owed; dryrun's reconcile shows how much." },
    { field: "invoice lines, tax", reason: "InvoiceList has totals only." },
    { field: "invoice and quote numbers", reason: "Kept as the record id; not carried as a number because FieldEdge numbers need not be numeric." },
    { field: "Parts Warranty, Labor Warranty", reason: "The documentation does not say whether these hold expiry dates or terms (\"10 years\"). Carried as equipment attributes; map them to warranty_parts_expires_on / warranty_labor_expires_on in your columns.json if your export holds dates." },
    { field: "Complete, Arrival, Promised Appointment", reason: "Their format is not documented. Carried as job custom fields, not as completion or arrival times." },
    { field: "QuoteList Resulting WO", reason: "The job a quote became, not the job it belongs to. Left in the raw row." },
    { field: "service agreements, contacts, price book, users", reason: "Not among the documented exports. Technicians appear by name on dispatches and are mapped by hand during `map`." },
    { field: "attachments", reason: "Not exported." },
  ],
};

export const fieldedge: SourceAdapter = createCsvAdapter({
  id: "fieldedge",
  displayName: "FieldEdge",
  preset: FIELDEDGE_COLUMNS,
  capabilities,
});
