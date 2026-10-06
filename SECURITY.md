# Security Policy

## Reporting

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/habrevaya/open-trades-os-migration/security/advisories/new)
on this repository. Please do not open a public issue.

We will acknowledge within 3 business days and aim to ship a fix within 90
days, and will credit you in the advisory unless you prefer otherwise.

## What matters most here

This toolkit handles a company's entire customer history and the credentials
to the accounts it comes from. Treated as critical:

- **Credential exposure.** API keys, OAuth tokens or the OpenTradesOS token
  appearing in logs, error messages, snapshots, the load ledger or anything
  written to disk unencrypted that the docs do not say is.
- **Writing to the wrong place.** Any path that loads data into an
  organization other than the one the token belongs to, or resumes into a
  different target.
- **Hostile input.** An export file (CSV or a workbook) that makes the toolkit
  read or write outside its working directory, run anything, or exhaust memory.
