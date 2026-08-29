# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or open a security advisory for this repository. Do not include real credentials, personal data, customer lists, or production logs in a public issue.

## Deployment boundary

The repository ships with real delivery disabled and placeholder-only configuration. Keep secrets outside Git, restrict secret files to the service account, use TLS certificate verification, and expose the dashboard only behind authentication and HTTPS when deploying beyond localhost.
