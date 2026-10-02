# Contributing

The most valuable contribution is not code. If you have moved data off
Jobber, ServiceTitan, Housecall Pro, Workiz, ServiceM8 or FieldEdge, you know
what breaks. Open an issue with the "An export or migration went wrong" form
and describe it, with invented example data, never real customer records.

## The one hard rule

Every source reads only what the account owner can get out of their own
account: their own API credentials, or their own exports. No scraping, no
shared credentials, no working around a platform's terms. A pull request that
does otherwise will not be merged, however useful.

## How a change gets in

1. **Open an issue first for a new source or anything large.**
2. **Fork, branch, and open the pull request into `develop`.** `main` is what
   gets released.
3. **CI runs** typecheck, lint, the tests, the build and a CodeQL scan.
   Fixtures must be synthetic.
4. **The maintainer reviews every pull request.** The review is requested
   automatically (`.github/CODEOWNERS`).
5. **Merged into `develop`, then released** to `main` and npm.

Security problems never go in a public issue: see [SECURITY.md](SECURITY.md).
By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```bash
pnpm install
pnpm test
pnpm dev sources
```

A new adapter cites the vendor's documentation at the top of its file, lists
what it cannot read in its `sources` entry rather than guessing, and comes
with tests that use undici's MockAgent or synthetic fixtures.
