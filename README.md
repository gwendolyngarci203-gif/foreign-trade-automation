# Foreign Trade Automation

Foreign Trade Automation is a workflow platform for turning company discovery into validated, reviewable outreach decisions with traceable feedback.

## Architecture

The project is organized around a staged business pipeline:

`Collection -> Contact -> Discovery -> Pipeline -> Validation -> Draft -> Approval -> Delivery -> Feedback`

Each stage produces explicit artifacts and audit events. Approval remains a decision boundary; delivery and mutable runtime state are not performed by the public repository itself.

## Main capabilities

- company and contact collection workflows
- discovery and qualification processing
- pipeline artifact validation
- draft and auto-approval decision services
- audit and observability envelopes with trace context
- delivery readiness and feedback reconciliation
- read-only control-plane and health tooling

## Repository layout

- `app/`: application code and tests
- `tools/`: operationally bounded tooling
- `deploy/`: sanitized release definitions and read-only checks
- `docs/`: project documentation and engineering history
- `plans/`: reviewed plans and release metadata

## Safety boundary

This public mirror contains no credentials, `.env` files, browser profiles, runtime stores, mailbox state, queue/outbox data, or private recovery material. Production deployment, SMTP/IMAP actions, service control, and runtime mutation require a separate restricted deployment system and are not performed by this repository.

## Source relationship

The complete engineering source is maintained separately in the D workspace. This directory is a sanitized public release candidate generated from that source. Public synchronization must use an explicit reviewed manifest; the public repository must never become the source of truth for production runtime state.
