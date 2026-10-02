# FieldEdge

FieldEdge has no public API. What it does have is five exports an owner can
run from their own account, and this source reads them: Generic CSV with
FieldEdge's columns built in.

```
npx @opentradesos/migrate extract --source fieldedge --from ./fieldedge-exports --out ./snapshot
```

## 1. Export the five reports

From your own FieldEdge account, as documented in
[Export your FieldEdge data](https://help.servicetitan.com/how-to/import-fe)
(that page is ServiceTitan's onboarding guide; it is the only published list
of these reports' columns we have found):

| Report | Where | File |
|---|---|---|
| Customers | **Customers** tab, **Export** | `CustomerList.xlsx` |
| Dispatching | **Dispatching** tab, **Export** | `DispatchList.xlsx` |
| Invoices | **Invoices** tab, set **every filter at the top to All**, **Export** | `InvoiceList.xlsx` |
| Quotes | **Quotes** tab, **Export** | `QuoteList.xlsx` |
| Equipment | **Reports > Customer Reports > Equipment List**, **Export** | `EquipmentList.xlsx` |

The invoice filters matter: left alone, FieldEdge exports only the last six
months. If a report errors, run it in one-year batches and combine them.

## 2. Save each as CSV

Open each in Excel and **Save As > CSV UTF-8**, keeping the name
(`CustomerList.csv`, `DispatchList.csv`, `InvoiceList.csv`, `QuoteList.csv`,
`EquipmentList.csv`), all in one directory. Do not reorder, rename or delete
columns; unknown extra columns are harmless and kept.

Only `CustomerList.csv` is required. A report you did not export is simply
not in the snapshot.

## What comes from where

| Canonical | From | Columns |
|---|---|---|
| customer | CustomerList | Name (also the id), Email, Phone, Address 1, Address 2, City, State, Zip as the billing address; Active, Company, Full Name as custom fields |
| property | CustomerList | One per customer, at Address 1, Address 2, City, State, Zip |
| job | DispatchList | WO# (id), Customer, Task (Duration) as the summary, Status, Lead Source; one visit at Schedule Date/Time with Tech. PO#, Promised Appointment, Arrival, Complete, Priority, Est Complete as custom fields |
| invoice | InvoiceList | Invoice # (id), Customer, WO #, Date, Due Date, Total, Due (the balance) |
| estimate | QuoteList | Quote # (id), Customer, Status, Date, Expiration, Amount, Task |
| equipment | EquipmentList | Customer, Equip. Name, Equip. Type, Manufacturer, Model, Serial #, Install; Parts Warranty, Labor Warranty, Replace Date as attributes |

The preset is `FIELDEDGE_COLUMNS` in `src/adapters/fieldedge/index.ts`.

## What to check before trusting it

- **Customers are joined by name.** No export carries a customer id, so the
  Customer column of the other four reports is matched to Name in the
  Customer List. The documentation does not promise those are the same
  text. `profile` will tell you: every job, invoice or quote whose customer
  does not match is reported as an orphan. Two customers with the same name
  merge into one.
- **One property per customer**, from the Customer List address. A
  customer with several service addresses gets one; the others are in each
  dispatch row's raw data but are not in any key.
- **Warranty columns are text.** The documentation does not say whether
  Parts Warranty and Labor Warranty hold expiry dates or terms like
  `10 years`, so they are carried as attributes. If yours hold dates, map
  them (below).
- **Complete and Arrival** on the dispatch list are carried as custom
  fields, not as completion or arrival times, for the same reason.
- **A work order dispatched twice** appears twice under the same WO#;
  `profile` reports it as a duplicate id.
- **Paid invoices without payments.** The Due column is the balance, so the
  snapshot's receivables are right, but no export lists the payments that
  reduced them. Loaded as they stand, the target records each invoice's
  full total as owed; `dryrun`'s predicted reconcile shows the open balance
  off by exactly the paid amount. Decide how to carry those payments before
  loading invoices.
- **Invoices for work orders outside the dispatch export** wait on a job
  that is not there, and `dryrun` names each one. Export dispatches for the
  same range as invoices.
- **Not exported at all:** payments, invoice lines and tax, service agreements, contacts, the price
  book, users (technicians appear by name, and are mapped during `map`) and
  attachments.

## Overriding the preset

A `columns.json` beside the exports is laid over the preset, file by file
and column by column, so a fix is one line. To read the warranty columns as
expiry dates:

```json
{
  "files": {
    "equipment": {
      "columns": {
        "warranty_parts_expires_on": "Parts Warranty",
        "warranty_labor_expires_on": "Labor Warranty"
      }
    }
  }
}
```

Everything in [generic-csv.md](generic-csv.md) applies: `dateOrder`,
`delimiter`, money and date parsing, and the documented column names on the
left-hand side.
