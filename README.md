# Foreign Trade Automation Toolkit

A self-hosted reference toolkit for organizing buyer data, contact queues, email drafts, delivery safeguards, and mailbox feedback.

This public repository is a clean, standalone distribution. It contains no production credentials, private company identity, customer data, proprietary images, server addresses, or deployment access to any maintainer-operated system.

## What is included

- Buyer and contact data dashboard
- Persistent collection queues and checkpoints
- Staged outreach pipeline
- Contact validation, suppression, deduplication, and delivery circuit breakers
- Draft generation through an OpenAI-compatible Responses API
- SMTP outbox safeguards and IMAP feedback parsing
- Docker and local Node.js examples

## Quick start

Requirements: Node.js 20 or newer.

```bash
git clone <repository-url>
cd foreign-trade-automation
npm test
npm start
```

Open <http://127.0.0.1:4173>.

The included synthetic dataset is loaded from `examples/sample-source.json`. Replace it with your own data by setting `SOURCE_PATH`.

## Docker

```bash
cp deploy/.env.runtime.example deploy/.env.runtime
docker compose -f deploy/compose.yaml up --build
```

The container listens on <http://127.0.0.1:4173>. Runtime data stays in `deploy/runtime-data/`, which is ignored by Git.

## Configuration

All external systems are opt-in and must use your own accounts:

- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`
- `SMTP_*` for your mail provider
- `MAILBOX_ACCOUNTS_PATH` for your own IMAP/SMTP account file
- `SOURCE_PATH` for your own buyer/contact JSON
- `SENDER_PROFILE_PATH` for your own legal sender identity

Real email delivery is disabled by default:

```dotenv
EMAIL_SENDING_ENABLED=false
EMAIL_ALLOW_UNVERIFIED=false
```

Do not enable delivery until you have verified recipient authorization, applicable law, provider terms, sender identity, unsubscribe handling, suppression handling, and bounce/complaint feedback.

## Safety model

The toolkit keeps the following controls even when delivery is enabled:

- durable outbox state before SMTP transmission
- global recipient deduplication
- suppression of opt-outs, complaints, and hard bounces
- per-account, per-company, batch, and daily limits
- circuit breakers for provider and feedback failures
- explicit handling for CAPTCHA, MFA, credentials, and permissions

The public repository does not include browser sessions, passwords, cookies, private keys, live mailbox files, runtime databases, or remote deployment credentials.

## Project layout

```text
app/          Node.js service, dashboard, pipeline, and tests
deploy/       Local Docker example and environment template
examples/     Synthetic sample data
plans/        Disabled-by-default example managed plan
Requirement/  Generic integration requirements
tools/        Reusable local processing and feedback components
```

## Tests

```bash
npm test
```

No external account or real email is required by the test suite.

## Responsible use

This software is infrastructure, not permission to send unsolicited messages or bypass a platform's controls. Use only data and accounts you are authorized to access. Comply with privacy, anti-spam, consumer protection, platform, and mail-provider rules in every applicable jurisdiction.

## License

MIT. See [LICENSE](LICENSE).
