#!/usr/bin/env python3
import smtplib
import ssl
import sys


def load_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key] = value
    return values


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: check-smtp-auth.py ENV_FILE")
    values = load_env(sys.argv[1])
    host = values.get("SMTP_HOST", "")
    port = int(values.get("SMTP_PORT", "465"))
    user = values.get("SMTP_USER", "")
    password = values.get("SMTP_PASS", "")
    if not all((host, port, user, password)):
        raise SystemExit("SMTP configuration is incomplete")
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL(host, port, timeout=20, context=context) as client:
        client.login(user, password)
    print("SMTP TLS connection and authentication passed; no message was sent")


if __name__ == "__main__":
    main()
