# ServiceTitan

You export your own reports from your own ServiceTitan account, put the
files in one folder, and run one command. This toolkit never connects to
ServiceTitan, never asks for your ServiceTitan login, and never calls its
API.

```
npx @opentradesos/migrate extract --source servicetitan --from ./servicetitan-exports --timezone America/Chicago --out ./snapshot
npx @opentradesos/migrate profile --in ./snapshot
```

Use your own time zone after `--timezone` (the one your ServiceTitan account
runs in: `America/New_York`, `America/Denver`, `America/Los_Angeles`, ...).
It keeps a 9:00 appointment at 9:00 your time.

Allow an afternoon. Most of it is ServiceTitan building reports.

## Before you start

- **Your package.** Building your own reports in ServiceTitan needs the
  **Works** package, or an older Legacy/Non-Packaged account. On Starter or
  Essentials you can still export your customer list and your pricebook
  (steps 1 and 10), but not jobs or invoices: ask your ServiceTitan
  Customer Success Manager what they can export for you.
  ([ServiceTitan: Invoices report template](https://help.servicetitan.com/docs/invoices-report-template))
- **Permissions.** You need permission to create and export reports. If the
  Export button is missing, ask whoever administers your account.
- **One folder.** Make a folder, say `servicetitan-exports`, and save every
  file below into it under the name given. Capitals and spaces do not
  matter; the words do.

## How every report works

ServiceTitan's own steps
([Create custom reports](https://help.servicetitan.com/docs/create-custom-reports),
[Run, filter, and export reports](https://help.servicetitan.com/docs/run-report)):

1. **Reports** in the top bar, then **Create Report**, then **All**, then
   click the template named below.
2. Under *Columns to be displayed in the report*, tick the columns listed
   below. Type a column's name in the search box to find it. Extra columns
   do no harm; leave them in if you like.
3. Name the report (for example "Migration - Jobs") and **Save**.
4. Open it, set the filters below, then **Run Report**.
5. **Export**, choose **Export to XLSX**, and **Export**. Do not tick
   *Export only aggregated data*.
6. Rename the downloaded file to the name below and move it into your folder.

**The date range.** Click the **From - To** field and pick, on the calendar,
the day you started using ServiceTitan through today. Use the same range for
jobs, invoices, invoice items, payments and estimates, or invoices will
point at jobs that are not in your files (`profile` will tell you if they
do).

**Too big for one go?** If a report will not run or will not export, run it
one year at a time and number the files: `Invoices 2019.xlsx`,
`Invoices 2020.xlsx`, and so on. Every file that starts with the name below
is read. Do not let the years overlap.

The ID columns are the important ones. They are how a payment finds its
invoice and an invoice finds its job. ServiceTitan lists them as the
columns its own reports join on
([multi-template reports](https://help.servicetitan.com/docs/create-and-run-multi-template-reports)).

## The reports

### 1. Customers: `Customers.xlsx`

**Reports > Customer List** (a built-in report, on every package). Tick
**Show Inactive Customers**, Run, Export to XLSX.
([Customer List report](https://help.servicetitan.com/docs/customer-list-report))

Columns it has: Customer ID, Customer Name, Type, Phone Number, Email, Full
Address, Do Not Mail, Do Not Service, Customer Tags.

Or build one from the **Customers** template with Customer ID, Customer
Name, Customer Type, Phone Number, Email, Full Address, and tick **Show
Inactive Customers**.

### 2. Locations: `Locations.xlsx`

Template **Locations**. Columns: **Location ID**, **Customer ID**, Location
Name, Location Address, Location Phone.
([Locations template](https://help.servicetitan.com/docs/locations-report-template))

### 3. Technicians: `Technicians.xlsx`

Template **Technician Performance**. Columns: **Name** (on by default). Tick
**Include Inactive Technicians**. Date range: your whole history.
([Technician Performance template](https://help.servicetitan.com/docs/technician-performance-report-template))

### 4. Jobs: `Jobs.xlsx`

Template **Jobs**. **Filter by: Job Creation Date**, whole history, so
canceled and unfinished jobs come too.
([Jobs template](https://help.servicetitan.com/docs/jobs-report-template))

Columns: **Job ID**, **Customer ID**, **Location ID**, Job #, Job Type, Job
Campaign, Business Unit, Invoice #, Total, Completion Date (most are on by
default), and if you can find them: Job Status, Job Summary, Job Start Date,
Primary Technician.

### 5. Invoices: `Invoices.xlsx`

Template **Invoices**. **Filter by: Invoice Date**, whole history. (Filtering
by completion or start date leaves out invoices with no job, such as
membership billing.) Leave *Hide Empty Invoices* unticked.
([Invoices template](https://help.servicetitan.com/docs/invoices-report-template))

Columns: **Invoice ID**, **Job ID**, **Customer ID**, Invoice #, Invoice
Status, Invoice Date, Total, Balance (most on by default), and from *Invoice
Totals* and *Invoice Dates*: Subtotal, Tax, Due Date.

### 6. Invoice items: `Invoice Items.xlsx`

Template **Invoice Items**. **Filter by: Invoice Date**, the same range as
invoices. One row per item on an invoice.
([Invoice Items template](https://help.servicetitan.com/docs/invoice-items-report-template))

Columns: **Invoice ID**, Item Name, Item Code, Item Price, Invoice Number (on
by default), and from *Invoice Item Details*: Quantity, Item Description,
Taxable.

### 7. Payments: `Applied Payments.xlsx`

Template **Applied Payments**. Whole history. One row per payment applied
to an invoice.
([Applied Payments template](https://help.servicetitan.com/docs/applied-payments-report-template))

Columns: **Invoice ID**, **Customer ID**, Payment Type, Payment Method,
Amount, Invoice Number, Memo (on by default), from *Dates*: Paid On, and
Payment ID if the template offers it (it keeps two identical payments on the
same day apart).

### 8. Estimates: `Estimates.xlsx`

Template **Estimates**. **Filter by: Creation Date**, whole history.
([Estimates template](https://help.servicetitan.com/docs/estimates-report-template))

Columns: **Estimate Id**, **Customer ID**, **Location ID**, **Parent Job
ID**, Estimate Name, Estimate Status, Subtotal (on by default), and if you
can find them: Tax, Total, Creation Date.

### 9. Equipment: `Equipment.xlsx`

Template **Equipment**. Whole history.
([Equipment template](https://help.servicetitan.com/docs/equipment-report-template))

Columns: **Location ID**, Customer ID, Equipment Type, Equipment name,
Manufacturer, Model, Serial Number, Equipment Code, Memo, Cost, and from
*Dates*: Installed On.

### 10. Memberships: `Memberships.xlsx`

Template **Customer Memberships**. Leave *Sold On* empty, set **From - To**
to your whole history, and select every **Membership Status**.
([Customer Memberships template](https://help.servicetitan.com/docs/customer-memberships-report-template))

Columns: **Membership ID**, **Customer ID**, **Location ID**, Membership
Type, Membership Status, From, To, Next Billing Date, Sold By (most on by
default).

### 11. Pricebook: `Pricebook.xlsx`

Not a report: **Pricebook** in the top bar, **Import/Export** in the side
menu, the **Export** tab, Export Type **Pricebook (Settings, Materials and
Part Link)**. Save the workbook as it comes; its Services, Materials and
Equipment sheets are all read.
([Import and export your pricebook](https://help.servicetitan.com/docs/import-and-export-your-pricebook),
[the template's columns](https://help.servicetitan.com/docs/pricebook-excel-template))

Only `Customers.xlsx` is required. Anything you skip is simply not in the
snapshot. If you saved a file as CSV instead, that works too.

## Then

```
npx @opentradesos/migrate extract --source servicetitan --from ./servicetitan-exports --timezone America/Chicago --out ./snapshot
npx @opentradesos/migrate profile --in ./snapshot
```

Read the profile before anything else. In particular:

- **`invoice.orphan_job`, `invoice.orphan_customer`, `payment.orphan_invoice`,
  `job.orphan_property`, `property.orphan_customer`**: a record whose ID is
  not in the other files. Usually two reports ran over different dates, or a
  report is missing its ID column.
- **`invoice.payments_do_not_match_balance`**: the payments applied to an
  invoice do not add up to its total less its balance. A payment report over
  a shorter range does this. So would ServiceTitan writing a payment's whole
  amount on each invoice it was split across; the documentation does not
  say which it does, so this check is how you find out.
- **Fill rates** for each field. A column that is always empty usually means
  a column you did not tick, or one whose header in your file differs from
  what this toolkit expects (below).
- **Unreadable records**, each named by its ID with the reason.

Then `map`, `dryrun`, `load` and `reconcile`, as for every source
([loading.md](loading.md)). Technicians are matched by name during `map`.

## What comes across, and what does not

| In OpenTradesOS | From | Joined on |
|---|---|---|
| customers | Customers | Customer ID |
| locations (properties) | Locations | Location ID, Customer ID |
| technicians | Technicians | Name |
| jobs, one visit each | Jobs | Job ID, Customer ID, Location ID; visit at Job Start Date with the Primary Technician |
| invoices, tax as charged | Invoices | Invoice ID, Job ID, Customer ID |
| invoice lines | Invoice Items | Invoice ID; Item Price is the line's total, the unit price is that over the Quantity |
| payments, applied to invoices | Applied Payments | Invoice ID, Customer ID; one payment per row |
| estimates | Estimates | Estimate Id, Parent Job ID, Customer ID, Location ID; loaded as one line carrying the subtotal |
| equipment | Equipment | Location ID |
| memberships, as service agreements | Customer Memberships | Membership ID, Customer ID, Location ID |
| price book | Pricebook export | ID; one item per row of Services, Materials, Equipment |

Money is read to the cent exactly as ServiceTitan shows it. Dates with no
time stay calendar dates; times become your time zone.

Not carried:

- **Payments not applied to an invoice** (deposits, credit on account). The
  Applied Payments report only lists applied ones, and All Payments, which
  has the rest, carries no Customer ID in ServiceTitan's documentation.
- **Every appointment of a multi-visit job.** The Jobs report is one row per
  job, so each job gets one visit.
- **The visits a membership generates** (recurring service events) and how
  often they recur. Memberships arrive with their type, dates and status;
  set their schedules up again after loading.
- **Estimate items.** The Estimates report is one row per estimate.
- **Equipment warranty dates.** ServiceTitan's documentation does not name
  those columns. Map them yourself (below) once you see your file.
- **Contacts, photos and documents, call recordings, forms.**
- **Invoice lines linked to price book items.** Lines arrive as charged.

`npx @opentradesos/migrate sources` prints the same list.

## Which headers are confirmed

The preset is `SERVICETITAN_COLUMNS` in
`src/adapters/servicetitan/reports.ts`, every header marked.

**Named in ServiceTitan's documentation** (help.servicetitan.com, read
1 October 2026): every ID column above; Customer List's Customer ID, Customer
Name, Type, Phone Number, Email, Full Address, Do Not Mail, Do Not Service,
Customer Tags; Locations' Location ID, Location Name, Location Address,
Location Phone; Jobs' Job #, Job Type, Job Campaign, Campaign Category,
Business Unit, Invoice #, Total, Completion Date; Invoices' Invoice #,
Invoice Status, Total, Balance, Invoice Date; Invoice Items' Item Name, Item
Code, Item Price, Invoice Number; Applied Payments' Payment Type, Payment
Method, Amount, Invoice Number, Memo, Paid On; Estimates' Estimate Id,
Estimate Name, Parent Job ID, Estimate Status, Subtotal; Equipment's
Equipment Code, Equipment Type, Model, Equipment name, Manufacturer, Serial
Number, Memo, Cost, Installed On; Customer Memberships' Membership ID,
Membership Type, Membership Status, From, To, Next Billing Date, Sold By,
Activation Method; Technician Performance's Name; and the pricebook
workbook's ID/Id, Code, Name, Description/Item Description, Price, Cost,
Taxable, Active.

**Our best reading, not yet seen in a real export:** Customer Type (on the
Customers template), Job Status, Job Summary, Job Start Date (or Scheduled
Date), Primary Technician, the invoice's Subtotal, Tax and Due Date, the
item's Quantity, Item Description and Taxable, the estimate's Tax, Total
and Creation Date, and Payment ID. ServiceTitan's documentation names the
section each is in but not the header. If one of these is missing from your
file, that field is simply empty, and `profile`'s fill rates show it.

## When a header in your file is different

Put a `columns.json` in the folder. It is laid over the preset one column at
a time, with our name on the left and yours on the right. For example, if
your invoice report calls tax "Sales Tax Amount" and your equipment report
has warranty end dates:

```json
{
  "files": {
    "invoices": { "columns": { "tax_total": "Sales Tax Amount" } },
    "equipment": {
      "columns": {
        "warranty_parts_expires_on": "Manufacturer Warranty End",
        "warranty_labor_expires_on": "Service Provider Warranty End"
      }
    }
  }
}
```

To switch one of ours off, map it to `""`. If your Job # or Invoice #
values contain letters, they cannot be a number in OpenTradesOS; switch them
off with `"number": ""` under `jobs` or `invoices` and each record still
loads, with OpenTradesOS numbering it. Everything in
[generic-csv.md](generic-csv.md) applies.

If you would tell us which headers your real exports have, open an issue:
that is how the "best reading" list gets shorter.

## Advanced: a snapshot you produced yourself

If you already have your data in the [canonical snapshot
format](snapshot-format.md) (one `customer.ndjson` and so on, each record
with `"sourceSystem": "servicetitan"` and its ServiceTitan ID as
`sourceId`), produced from your own tenant by whatever means your own
agreement with ServiceTitan provides, import it instead:

```
npx @opentradesos/migrate extract --source servicetitan --format canonical --from ./servicetitan-snapshot --out ./snapshot
```

A folder with a `customer.ndjson` in it is read this way even without
`--format`. Every record is checked against the canonical schema as it is
read and reported by ID and field if it fails; a record that names any
source but `servicetitan` is refused, so two systems' IDs cannot collide.
What arrives is exactly what you produced.
