# Release JSON Merge Review

## Source

- C source: `deploy/release.json`
- C SHA-256: `7c8c722c5bb856baa5bb9814e4d5abe3eecdb11876be4f1228908077b93c1c7c`
- D target: absent

## Decision

The file is imported as a new candidate on `feature/phase12-cd-consolidation`, not onto `production/main`. Before release use, compare every release path and hash against the D deployment manifest. Any remote/runtime values, secrets, environment references, or service activation fields require manual review and are not automatically adopted.

## Safety

No D production configuration was overwritten. The C file is treated as release metadata only until schema and dependency tests pass.
