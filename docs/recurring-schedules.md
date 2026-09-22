# Recurring schedules: the hard part

The single biggest source of migration defects, and the reason this toolkit
has a `dryrun` stage.

## Four models in the wild

| Model | How it works | Who does this | What breaks |
|---|---|---|---|
| **Rule** | A stored recurrence rule plus an anchor date. Occurrences computed on read | Calendar-style systems | Rule dialects differ. Exceptions and skipped occurrences are stored separately and easy to lose |
| **Materialized series** | Every future occurrence exists as a real record | Several FSM platforms | Import creates thousands of future rows. Deciding how far forward to carry is a judgment call |
| **Anchored to completion** | The next visit is scheduled relative to when the last one actually finished, not to a calendar | Route-based trades: pool, pest, lawn | The anchor lives in completion data. Miss it and every future date drifts |
| **Manual list** | No recurrence at all. The office re-books by hand each cycle | Small shops, spreadsheet migrations | There is nothing to migrate. The pattern has to be inferred, and inference must be reviewed by a human |

## Rules for adapters

1. **Never silently invent a schedule.** If the source model is ambiguous,
   surface it in `profile` and force a decision during `map`.
2. **Carry the anchor, not just the cadence.** "Every 90 days" without knowing
   what it is 90 days from is not a schedule.
3. **Materialize a bounded window.** Default to the next 12 months, and record
   the rule so later occurrences regenerate correctly.
4. **Preserve exceptions.** A skipped, moved or cancelled occurrence in the
   source is data, not noise. Losing it means re-sending a visit the customer
   already declined.
5. **Reconcile the next occurrence date per agreement**, not just the count.
   A schedule that is off by a cycle passes a count check and still causes a
   missed maintenance visit, which is the exact failure a contractor will never
   forgive.
