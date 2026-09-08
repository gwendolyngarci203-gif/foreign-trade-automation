# Public Deployment Final Policy

## A: Suitable for public source

`deploy/release.json`, `deploy/source/source.json`, `deploy/Dockerfile`, `deploy/requirements-deploy.txt`, read-only health/status scripts, isolation checks, documentation, and declarative configuration that contains no private host or credential data.

## B: Public only with an explicit non-execution warning

`deploy/compose.yaml`, `deploy/nginx-prospect-ops.conf`, `deploy/CIRCUIT_RECOVERY.md`, and operational documentation. These describe deployment topology or recovery concepts and must not be run from the public mirror without a separate deployment review.

## C: Must not be public

The following were removed from this public candidate and retained in the export quarantine, while remaining untouched in D:

- `deploy/deploy-server.py`
- `deploy/one-click-deploy.ps1`
- `deploy/update.sh`
- `deploy/update-systemd.sh`
- `deploy/restore.sh`
- `deploy/check-smtp-auth.py`
- all `dakings-*.service` and `dakings-*.timer` files

Reason: these files can perform SSH/host operations, systemd or timer control, runtime mutation, service changes, SMTP/IMAP operations, or production restoration. They are not required to explain the public application source and would violate the public boundary.
