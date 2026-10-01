# Workiz

```
export WORKIZ_TOKEN=...            # Settings > Integrations > Developer
npx @opentradesos/migrate extract --source workiz --out ./snapshot
```

Reads through Workiz's public REST API, documented at
[developer.workiz.com](https://developer.workiz.com) (the OpenAPI document
behind it is [api.json](https://developer.workiz.com/api.json)). Getting the
token: [Accessing your Workiz API credentials](https://help.workiz.com/hc/en-us/articles/18053137531409-Accessing-your-Workiz-API-credentials).

Only the API **token** is needed. Workiz also issues an API secret, which it
requires for writes; this toolkit never writes to Workiz, so never asks for it.
The token goes in the URL path (that is how Workiz authenticates), so the
adapter strips it out of every error message it raises.

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `WORKIZ_SINCE` | `2000-01-01` | Earliest job date to read. Without one, Workiz returns only the last 14 days. |
| `WORKIZ_ACCOUNT` | `Workiz account` | A name for the account. Workiz does not tell a token which account it belongs to; set this if you load two Workiz accounts into one target. |

## What it reads

The public API reads **jobs** and **team members**, and nothing else.

| Canonical | From | Notes |
|---|---|---|
| user | `GET /team/all/` | Active team members only |
| customer | jobs | Split out of the jobs that name each `ClientId`, once, from the most recently scheduled job |
| property | jobs | One per client and distinct service address; ids derived from the normalised address |
| job | `GET /job/all/` | One visit per job, with its team, converted from the job's own `Timezone` |
| invoice | jobs | One per job with a non-zero `JobTotalPrice` or `JobAmountDue`; no lines, no tax split |

## What it cannot read

Listed by `sources` too:

- **Clients** as records: there is no client list. A client with no job in
  the range you extract is not in the snapshot.
- **Payments**: the API can add one but not list one. Invoice balances in
  the snapshot are right; who paid what, when, is not there. Loaded as they
  stand, invoices would carry their paid part as owed, because nothing
  records the payment against them. `dryrun`'s predicted reconcile shows the
  open balance off by exactly that amount. Decide how to carry those
  payments (a payments export from Workiz's reports, through Generic CSV, is
  one way) before loading invoices.
- **Invoice lines**, **leads**, **equipment**, **contacts**, **service plans**,
  **attachments**: not exposed.
- **`SubTotal`**: the published schema does not say whether its difference
  from `JobTotalPrice` is tax, discount or both, so the invoice carries the
  total with no tax split, and `SubTotal` stays in the payload.
- **Completion time**: `LastStatusUpdate` is the last status change of any
  kind, so it is not used.
- **Future jobs**: `job/all` reads from `start_date` "until today". Check the
  job count in Workiz against `profile` if you have work booked ahead.

## Paging

Workiz pages with `offset` and `records` (at most 100). The published schema
calls `offset` a record offset; a client library in use treats it as a page
number. Guessing wrong either repeats 99 jobs per page or stops after the
first hundred and reports success, so the adapter measures it on the first
run (offset 1 either overlaps offset 0 by 99 jobs or not at all) and refuses
to continue if the answer is neither. The answer is kept in the checkpoint,
so a resumed run pages the same way.

Rate limits are not published. 429 and 5xx responses are retried with
backoff, honouring `Retry-After`.
