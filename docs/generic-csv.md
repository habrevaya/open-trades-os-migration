# Generic CSV

The universal fallback. Every platform in this industry will give an owner a
spreadsheet of their customers, including the ones that give nothing else.
A shop leaving FieldEdge, a decade of Excel, or a QuickBooks customer list can
put those exports in one directory and get them through the same canonical
model, the same `profile`, the same `dryrun` and the same loader as Jobber.

```
npx @opentradesos/migrate extract --source csv --from ./exports --out ./snapshot
```

Only `customers.csv` is required. Every other file is optional, and an entity
with no file is simply not in the snapshot.

## Files and columns

Headers are matched by name, in any order. Unknown columns are kept in the
snapshot (so `profile` and the audit trail still have them) and otherwise
ignored. Any column named `custom:<label>` becomes a custom field called
`<label>` on customers, properties and jobs.

Lists inside a cell (tags, technician ids, a property's customers) are
separated with `;`.

| File | Columns |
|---|---|
| `customers.csv` | **id**, **name**, type (`residential` / `commercial`), email, phone, billing_line1, billing_line2, billing_city, billing_state, billing_postal_code, billing_country, lead_source, payment_terms_days, tax_exempt, notes, tags |
| `properties.csv` | **id**, customer_id (`;` for several), nickname, line1, line2, city, state, postal_code, country, latitude, longitude, access_notes |
| `users.csv` | **id**, name, email, phone, active, role |
| `price_book.csv` | **id**, **name**, code, kind (`service` `material` `equipment` `labor` `fee` `discount`), description, price, cost, taxable, duration_minutes, active |
| `jobs.csv` | **id**, **customer_id**, property_id, number, status, summary, description, job_type, lead_source, total, completed_at; or one visit inline as visit_start, visit_end, technician_ids, visit_status |
| `visits.csv` | id, **job_id**, start, end, completed_at, status, technician_ids, notes |
| `estimates.csv` | **id**, **customer_id**, property_id, job_id, number, status, title, issued_on, expires_on, subtotal, tax_total, total |
| `estimate_lines.csv` | **estimate_id**, option, name, description, quantity, unit_price, taxable, line_total |
| `invoices.csv` | **id**, **customer_id**, **balance**, job_id, number, status, issued_on, due_on, subtotal, tax_total, total |
| `invoice_lines.csv` | **invoice_id**, name, description, quantity, unit_price, taxable, tax_rate, tax_amount, line_total, price_book_item_id |
| `payments.csv` | **id**, **customer_id**, **amount**, **received_at**, method, status, invoice_id |
| `payment_allocations.csv` | **payment_id**, **invoice_id**, **amount** |
| `attachments.csv` | **id**, **entity_type** (`customer` `property` `job` `visit` `estimate` `invoice` `equipment`), **entity_id**, url or path, file_name, content_type |

Bold columns are required. A row missing one is reported as unreadable, by
id, rather than skipped quietly.

Child files are joined onto their parents by id: invoice lines onto
invoices, visits onto jobs, estimate lines onto estimates (grouped into
options by the `option` column), allocations onto payments. A child row whose
parent is not in the parent file is reported at extract time.

A payment with an `invoice_id` and no allocation rows is applied to that
invoice in full. A payment with neither is unapplied money (a deposit or a
credit), which is carried and reported, never dropped.

An attachment `path` is relative to the export directory.

## Values

- **Money**: `1234.5`, `$1,234.50`, `(120.00)` for a negative. Never a
  float internally. If the export writes integer cents, set `"cents": true`.
- **Yes/no**: `yes no y n true false 1 0 x`. Anything else (`maybe`) makes the
  row unreadable rather than guessing.
- **Dates**: ISO 8601 (`2024-03-14`, `2024-03-14T15:41:00Z`) as is, or
  slashed (`03/14/2024`, `3/14/2024 15:41`), read month first unless
  `"dateOrder": "DMY"`. Anything else is refused.
- **Balance**: an invoice with an empty balance is unreadable. Read as zero
  it would clear a real receivable.

## columns.json: an export that does not use these names

Put a `columns.json` beside the exports (or pass `--columns <file>`) to
rename files and headers without editing the export:

```json
{
  "delimiter": ";",
  "cents": true,
  "dateOrder": "DMY",
  "files": {
    "customers": {
      "file": "Customer List.csv",
      "columns": { "id": "Customer #", "name": "Customer Name", "email": "E-mail" }
    },
    "properties": {
      "file": "Customer List.csv",
      "columns": {
        "id": "Customer #", "customer_id": "Customer #",
        "line1": "Service Street", "city": "Service City", "state": "St", "postal_code": "Zip"
      }
    }
  }
}
```

Keys under `files` are the file names above without `.csv`. Under `columns`,
the documented name is on the left and the export's header on the right. The
same export file may be named for two entities and the same header may feed
two columns, which is how a customer list carrying a service address becomes
both customers and properties. `fixtures/csv/mapped` is a working example.

The settings are stamped onto every row in the snapshot, so `profile`,
`dryrun` and `load` read amounts the same way `extract` did, without needing
`columns.json` again.
