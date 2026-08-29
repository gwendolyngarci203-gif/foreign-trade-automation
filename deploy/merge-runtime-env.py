#!/usr/bin/env python3
import os
import pathlib
import sys


ALLOWED_KEYS = {
    "EMAIL_SENDING_ENABLED",
    "EMAIL_ALLOW_UNVERIFIED",
    "FEEDBACK_WEBHOOK_SECRET",
    "MAILBOX_REPLY_ENABLED",
    "MAILBOX_REPLY_DAILY_LIMIT",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_STARTTLS",
    "SMTP_TLS_REJECT_UNAUTHORIZED",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "PIPELINE_SENDER_COMPANY",
    "PIPELINE_SENDER_NAME",
    "PIPELINE_SENDER_TITLE",
    "PIPELINE_SENDER_EMAIL",
    "PIPELINE_SENDER_PHONE",
    "PIPELINE_SENDER_WEBSITE",
}


def parse_fragment(path):
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("runtime fragment contains an invalid line")
        key, value = line.split("=", 1)
        if key not in ALLOWED_KEYS:
            raise ValueError(f"runtime fragment key is not allowed: {key}")
        if "\n" in value or "\r" in value:
            raise ValueError(f"runtime fragment value is invalid: {key}")
        values[key] = value
    return values


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: merge-runtime-env.py TARGET FRAGMENT")
    target = pathlib.Path(sys.argv[1])
    fragment = pathlib.Path(sys.argv[2])
    updates = parse_fragment(fragment)
    if not updates:
        raise SystemExit("runtime fragment is empty")

    existing = target.read_text(encoding="utf-8").splitlines() if target.exists() else []
    output = []
    replaced = set()
    for line in existing:
        if "=" in line and not line.lstrip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in updates:
                output.append(f"{key}={updates[key]}")
                replaced.add(key)
                continue
        output.append(line)
    for key in sorted(updates):
        if key not in replaced:
            output.append(f"{key}={updates[key]}")

    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    os.chmod(target, 0o600)
    print(f"updated {len(updates)} runtime keys")


if __name__ == "__main__":
    main()
