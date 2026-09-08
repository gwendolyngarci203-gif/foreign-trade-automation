# Phase 12.6-O Release Reconstruction

## Status

An isolated D-only release branch was created: `release/phase12-6-o-d-only`. Release artifacts are limited to the D server, observability, approval adapter, tests, fixture, and approved runtime dependencies. C is not an input.

## Current blockers

- D has no tracked `deploy-safe-release.py`/executor in this branch, so safe deployment input is metadata-only until the deployment toolchain is rebuilt and audited.
- Production source still requires a separately approved real input with the locked schema/hash; the fixture is test-only.
- NetEase safety test requires a contract update plan, not a production behavior change.

## Decision

D can independently reconstruct a release candidate, but this phase does not authorize deployment. A human must approve the final source hash, manifest, rollback target, and safe transport preflight.

Reconstructed candidate: commit `0316b9fd96017924c3de046f2def3fabde94fff2`, manifest SHA256 `896111d7de0b0e29599f1b82c57555d82ddfb77c5ee58ea0e65940419a66a16e`, rollback `3e1c5db12dc484c1de5fd62be173d10defb28c51`.
