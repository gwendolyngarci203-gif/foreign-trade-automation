# Project Structure

- `app/`: application code, services, tests and public assets
- `config/`: non-secret configuration definitions
- `deploy/`: deployment definitions; credentials and runtime env remain protected in place
- `docs/phase-reports/`: Phase reports
- `migration/`: synchronization plans and archived migration evidence
- `recovery/`: recovery runbooks, blocker and dependency reports
- `tests/`: reserved for project-level tests
- `tools/`: operational and verification tools
- `app/.runtime`, `app/data`, `deploy/runtime-data`, `.codex_work`, browser profile paths: protected runtime/local state; never move into source control
