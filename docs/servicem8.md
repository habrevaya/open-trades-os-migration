# ServiceM8

There is no ServiceM8 API adapter, and `--source servicem8` says why.

ServiceM8's [Platform Policy](https://developer.servicem8.com/page/platform-policy),
which its API documentation asks every integration to follow, says the
ServiceM8 Platform may not be used to export user data to a product that
replicates a core ServiceM8 product or service without ServiceM8's
permission. OpenTradesOS is field service software. This toolkit only runs
on credentials or exports an owner provides for their own account, with no
way around any platform's terms, so it does not read ServiceM8 through the
API.

## Your own exports

What ServiceM8 lets an owner export from their own account goes through
[Generic CSV](generic-csv.md), like any spreadsheet:

- **Client List** and **Job List**, CSV exports of clients and job history,
  available to a Business Owner once the Advanced Reporting Pack add-on is
  switched on (Settings > ServiceM8 Add-ons). See
  [What is the Advanced Reporting Pack Add-on?](https://support.servicem8.com/hc/en-us/articles/202296784-What-is-the-Advanced-Reporting-Pack-Add-on).
  ServiceM8 notes these do not include all job-related data, and no files.
- **Materials**: Settings > Materials > Export Items (an Excel file; save it
  as CSV) for the price book.

ServiceM8 does not publish the column headers of these exports, so this
repository does not ship a column preset for them: one built from guessed
headers would map the wrong column without saying so. Open each export, then
write a `columns.json` naming its headers (left: the documented column, right:
the header in your file):

```json
{
  "files": {
    "customers": {
      "file": "<your client list>.csv",
      "columns": { "id": "<header>", "name": "<header>", "email": "<header>", "phone": "<header>" }
    },
    "jobs": {
      "file": "<your job list>.csv",
      "columns": { "id": "<header>", "customer_id": "<header>", "status": "<header>", "total": "<header>" }
    }
  }
}
```

and run:

```
npx @opentradesos/migrate extract --source csv --from ./servicem8-exports --out ./snapshot
npx @opentradesos/migrate profile --in ./snapshot
```

`profile` reports every job whose customer is not in the client list, which
is how a wrong id column shows itself.

If ServiceM8 gives permission for an API route, that changes this page, and
an adapter would follow the same contract as the others.
