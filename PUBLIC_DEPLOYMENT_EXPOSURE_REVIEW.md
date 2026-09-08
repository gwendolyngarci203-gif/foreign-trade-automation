# Public Deployment Exposure Review

## Classification

### A: Can be public after review

- `deploy/release.json`
- `deploy/source/source.json`
- `deploy/Dockerfile`
- `deploy/compose.yaml`
- health, status, and documentation files
- service/timer unit definitions as declarative source, subject to owner review
- `deploy/README.md`

### B: Public only with an explicit non-execution warning

- `deploy/compose.yaml`
- `deploy/nginx-prospect-ops.conf`
- recovery and operational documentation

These files are included only as reviewed source artifacts. They must not be executed by the public repository workflow.

### C: Prohibited from public export

- `.env*`, credentials, account/password material, SSH material
- `deploy/identity-source/*`
- deploy scripts, systemd/timer units, SMTP/IMAP tools, and restore/update executors
- runtime, mailbox, queue, outbox, browser profile, backup, recovery, and temporary build artifacts
- any generated cache such as `__pycache__`

## Boundary conclusion

The export does not include category C material. See `PUBLIC_DEPLOYMENT_FINAL_POLICY.md` for the exact removed paths and retained boundary.
