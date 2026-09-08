# Public Repository Structure Review

The candidate is organized for public readers without deleting engineering evidence.

## Public top level

- `app/`: application source, data schemas, public assets, and tests
- `tools/`: reviewed tooling that does not include private runtime state
- `deploy/`: sanitized release metadata, read-only checks, and non-secret definitions
- `docs/`: public documentation and `docs/engineering-history/`
- `migration/`: retained as a reserved source area; private/archive evidence was moved out of the public-facing root
- `plans/`: reviewed project plans

## History organization

- `docs/engineering-history/phase-reports/`
- `docs/engineering-history/migration-archive/`

No history was deleted. Recovery-private material, runtime stores, credentials, account files, and temporary build artifacts are not in the public candidate.
