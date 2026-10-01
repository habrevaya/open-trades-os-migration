# ServiceTitan

For ServiceTitan this toolkit does not connect to anything. **You** produce a
snapshot of **your own tenant**, and this repo imports the files you
produced. We never hold your ServiceTitan credentials and never call their
API, and no code in this repository does.

```
npx @opentradesos/migrate extract --source servicetitan --from ./servicetitan-export --out ./snapshot
npx @opentradesos/migrate profile --in ./snapshot
```

## What you produce

A directory of files in the [canonical snapshot format](snapshot-format.md):
`customer.ndjson` and as many of the others as you have, every record with
`"sourceSystem": "servicetitan"` and its ServiceTitan id as `sourceId`.

How you get your data out of your tenant is between you and ServiceTitan,
under your own agreement with them. Exports you run yourself from
ServiceTitan's own screens and reports are one way: a spreadsheet export can
also be read directly by [Generic CSV](generic-csv.md) with a `columns.json`
written after looking at its headers, without converting it to this format
at all. This repository does not publish ServiceTitan column presets,
because we have no documented column list to build one from.

## What the import does

- Reads every file, resumably, into a snapshot like any other source's.
- Checks every record against the canonical schema as it is read, and
  reports each one that fails by id and field, rather than loading it half
  formed. Money must be a decimal string; a JSON number is refused.
- Refuses any record whose `sourceSystem` is not `servicetitan`, so two
  systems' ids cannot collide in one load.
- From there, `profile`, `map`, `dryrun`, `load` and `reconcile` work as
  they do for every source.

What arrives is exactly what you produced. A recurring schedule states its
own recurrence model; tax arrives as applied, if you carried it; nothing is
inferred.
