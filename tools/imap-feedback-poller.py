"""Read-only multi-account IMAP sync plus feedback classification."""

import argparse
import email
import hashlib
import imaplib
import json
import os
import re
import ssl
import socket
import tempfile
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from email.utils import getaddresses, parseaddr, parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path


def clean_message_id(value):
    return value.strip().strip("<>")[:300]


def occurred_at(message):
    try:
        parsed = parsedate_to_datetime(message.get("Date", ""))
        if parsed is None:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def delivery_status(message):
    for part in message.walk():
        if part.get_content_type() != "message/delivery-status":
            continue
        payload = part.get_payload()
        blocks = payload if isinstance(payload, list) else [part]
        for block in blocks:
            recipient = str(block.get("Final-Recipient") or block.get("Original-Recipient") or "").split(";")[-1].strip().lower()
            action = str(block.get("Action") or "").lower()
            status = str(block.get("Status") or "")
            if "@" not in recipient:
                continue
            if action == "failed" or status.startswith("5"):
                return "hard_bounce", recipient
            if action == "delayed" or status.startswith("4"):
                return "soft_bounce", recipient
    return None


def complaint_recipient(message):
    for part in message.walk():
        if part.get_content_type() != "message/feedback-report":
            continue
        for key in ("Original-Rcpt-To", "Original-Mail-From"):
            recipient = str(part.get(key) or "").split(";")[-1].strip().lower()
            if "@" in recipient:
                return recipient
    return ""


def decode_header(value):
    try:
        return str(email.header.make_header(email.header.decode_header(str(value or "")))).strip()
    except (LookupError, UnicodeError):
        return str(value or "").strip()


def classify(message, own_domain):
    bounce = delivery_status(message)
    if bounce:
        event_type, recipient = bounce
        return {"type": event_type, "email": recipient}

    complaint = complaint_recipient(message)
    if complaint:
        return {"type": "complaint", "email": complaint}

    sender = parseaddr(message.get("From", ""))[1].strip().lower()
    if "@" not in sender or sender.rsplit("@", 1)[1] == own_domain:
        return None

    subject = decode_header(message.get("Subject", ""))
    if re.search(r"\b(unsubscribe|opt[ -]?out|remove me|stop emailing)\b|退订|不再联系", subject, re.I):
        event_type = "unsubscribe"
    elif str(message.get("Auto-Submitted", "")).lower() not in ("", "no") or str(message.get("Precedence", "")).lower() in {"bulk", "junk", "list", "auto_reply"}:
        event_type = "auto_reply"
    elif message.get("In-Reply-To") or message.get("References") or re.match(r"^(re|回复|答复)\s*:", subject, re.I):
        event_type = "reply"
    else:
        return None

    reference = message.get("In-Reply-To") or str(message.get("References", "")).split()[-1:] or [""]
    if isinstance(reference, list):
        reference = reference[0]
    return {"type": event_type, "email": sender, "messageId": clean_message_id(str(reference))}


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        if data.strip():
            self.parts.append(data.strip())


def decoded_part(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    for charset in (part.get_content_charset(), "utf-8", "gb18030", "latin-1"):
        if not charset:
            continue
        try:
            return payload.decode(charset, errors="replace")
        except LookupError:
            continue
    return payload.decode("utf-8", errors="replace")


def message_text(message):
    plain = []
    html = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_maintype() == "multipart" or part.get_content_disposition() == "attachment":
            continue
        if part.get_content_type() == "text/plain":
            plain.append(decoded_part(part))
        elif part.get_content_type() == "text/html":
            html.append(decoded_part(part))
    text = "\n".join(plain).strip()
    if not text and html:
        parser = TextExtractor()
        parser.feed("\n".join(html))
        text = "\n".join(parser.parts)
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:50000]


def mailbox_message(raw, account, uid, uid_validity, flags=b""):
    message = email.message_from_bytes(raw)
    sender_name, sender_address = parseaddr(message.get("From", ""))
    recipients = [address.lower() for _, address in getaddresses(message.get_all("To", [])) if address]
    body = message_text(message)
    identity = f"{account}|inbox|{uid_validity}|{uid}".encode()
    return {
        "id": hashlib.sha1(identity).hexdigest()[:20],
        "account": account,
        "folder": "inbox",
        "uid": uid,
        "uidValidity": uid_validity,
        "from": {"name": decode_header(sender_name), "address": sender_address.lower()},
        "to": recipients,
        "subject": decode_header(message.get("Subject", "")),
        "date": occurred_at(message),
        "messageId": clean_message_id(str(message.get("Message-ID", ""))),
        "inReplyTo": clean_message_id(str(message.get("In-Reply-To", ""))),
        "references": [clean_message_id(value) for value in str(message.get("References", "")).split()[-20:]],
        "unread": b"\\Seen" not in flags,
        "hasAttachments": any(part.get_content_disposition() == "attachment" for part in message.walk()),
        "snippet": re.sub(r"\s+", " ", body)[:240],
        "bodyText": body,
    }


def load_state(path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_accounts():
    config_path = os.environ.get("MAILBOX_ACCOUNTS_PATH", "").strip()
    if config_path:
        config = load_state(Path(config_path))
        accounts = config.get("accounts", [])
    else:
        user = os.environ.get("IMAP_USER") or os.environ.get("SMTP_USER", "")
        password = os.environ.get("IMAP_PASS") or os.environ.get("SMTP_PASS", "")
        accounts = [{"address": user, "password": password}] if user and password else []
    cleaned = []
    for account in accounts:
        address = str(account.get("address") or account.get("user") or "").strip().lower()
        password = str(account.get("password") or account.get("pass") or "")
        imap_host = str(account.get("imapHost") or os.environ.get("IMAP_HOST") or "").strip()
        smtp_host = str(account.get("smtpHost") or os.environ.get("SMTP_HOST") or "").strip()
        if account.get("enabled", True) and "@" in address and password and imap_host:
            cleaned.append({
                "address": address,
                "password": password,
                "imapHost": imap_host,
                "imapPort": int(account.get("imapPort") or 993),
                "smtpHost": smtp_host,
                "smtpPort": int(account.get("smtpPort") or 465),
            })
    if not cleaned:
        raise RuntimeError("mailbox credentials are missing")
    return cleaned


def post_event(base_url, secret, event, account):
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/feedback/events",
        data=json.dumps(event, separators=(",", ":")).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Feedback-Secret": secret,
            "X-Feedback-Source": f"imap:{account}"[:80],
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status not in (200, 202):
            raise RuntimeError(f"feedback API returned {response.status}")


def poll_account(account, account_state, mailbox, dry_run, lookback, secret, api_base, initial_limit, retain_limit):
    address = account["address"]
    counts = Counter()
    socket.setdefaulttimeout(30)
    box = imaplib.IMAP4_SSL(account["imapHost"], account["imapPort"], ssl_context=ssl.create_default_context())
    try:
        box.login(address, account["password"])
        status, _ = box.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("cannot EXAMINE INBOX")
        status, validity = box.response("UIDVALIDITY")
        uid_validity = validity[0].decode() if status == "UIDVALIDITY" and validity else "unknown"
        status, data = box.uid("search", None, "ALL")
        uids = [int(value) for value in (data[0].split() if status == "OK" and data and data[0] else [])]
        bootstrapping = not account_state or account_state.get("uidValidity") != uid_validity
        if dry_run:
            pending = uids[-lookback:] if lookback else uids[-initial_limit:]
        elif bootstrapping:
            pending = uids[-initial_limit:]
        else:
            pending = [uid for uid in uids if uid > int(account_state.get("lastUid", 0))]

        existing = {item["id"]: item for item in mailbox.get("messages", []) if item.get("account") == address}
        for uid in pending:
            status, parts = box.uid("fetch", str(uid), "(FLAGS BODY.PEEK[])")
            if status != "OK":
                raise RuntimeError(f"cannot fetch UID {uid}")
            raw = b"".join(part[1] for part in parts if isinstance(part, tuple) and len(part) > 1)
            flags = b" ".join(part[0] for part in parts if isinstance(part, tuple) and isinstance(part[0], bytes))
            summary = mailbox_message(raw, address, uid, uid_validity, flags)
            existing[summary["id"]] = summary
            item = classify(email.message_from_bytes(raw), address.rsplit("@", 1)[-1])
            if item:
                counts[item["type"]] += 1
                if not dry_run and not bootstrapping:
                    event = {
                        "eventId": f"imap-{hashlib.sha1(address.encode()).hexdigest()[:10]}-{uid_validity}-{uid}",
                        **item,
                        "occurredAt": occurred_at(email.message_from_bytes(raw)),
                    }
                    post_event(api_base, secret, {key: value for key, value in event.items() if value}, address)
            else:
                counts["ignored"] += 1

        if not dry_run:
            others = [item for item in mailbox.get("messages", []) if item.get("account") != address]
            current = sorted(existing.values(), key=lambda item: (item.get("uid", 0), item.get("id", "")))[-retain_limit:]
            mailbox["messages"] = others + current
            account_state.update({"uidValidity": uid_validity, "lastUid": max(uids, default=0)})
        return counts, len(uids)
    finally:
        try:
            box.logout()
        except Exception:
            pass


def poll(dry_run=False, lookback=0):
    accounts = load_accounts()
    secret = os.environ.get("FEEDBACK_WEBHOOK_SECRET", "")
    if not dry_run and not secret:
        raise RuntimeError("FEEDBACK_WEBHOOK_SECRET is missing")

    state_path = Path(os.environ.get("IMAP_FEEDBACK_STATE_PATH", "deploy/runtime-data/imap-feedback-state.json"))
    mailbox_path = Path(os.environ.get("MAILBOX_STORE_PATH", "deploy/runtime-data/mailboxes.json"))
    api_base = os.environ.get("FEEDBACK_API_BASE", "http://127.0.0.1:4173")
    initial_limit = max(1, min(int(os.environ.get("MAILBOX_INITIAL_SYNC_LIMIT", "50")), 200))
    retain_limit = max(initial_limit, min(int(os.environ.get("MAILBOX_RETAIN_LIMIT", "200")), 1000))
    state = load_state(state_path)
    if state.get("version") != 2:
        state = {"version": 2, "accounts": {}}
    mailbox = load_state(mailbox_path)
    if mailbox.get("version") != 1:
        mailbox = {"version": 1, "accounts": [], "messages": []}

    totals = Counter()
    statuses = []
    errors = []
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for account in accounts:
        address = account["address"]
        account_state = state["accounts"].setdefault(address, {})
        try:
            counts, remote_count = poll_account(
                account, account_state, mailbox, dry_run, lookback, secret, api_base, initial_limit, retain_limit
            )
            totals.update(counts)
            statuses.append({"address": address, "status": "synced", "lastSyncAt": now, "lastError": "", "remoteInboxCount": remote_count})
            totals["accounts_synced"] += 1
        except Exception as error:
            errors.append(f"{address}: {error}")
            previous = next((item for item in mailbox.get("accounts", []) if item.get("address") == address), {})
            statuses.append({"address": address, "status": "error", "lastSyncAt": previous.get("lastSyncAt"), "lastError": str(error)[:240], "remoteInboxCount": previous.get("remoteInboxCount", 0)})
            totals["accounts_failed"] += 1

    if not dry_run:
        mailbox["accounts"] = statuses
        mailbox["updatedAt"] = now
        save_state(state_path, state)
        save_state(mailbox_path, mailbox)
    if errors:
        raise RuntimeError("; ".join(errors))
    return totals


def self_test():
    reply = email.message_from_string("From: buyer@example.com\nSubject: Re: Quote\nIn-Reply-To: <m1@example>\n\nThanks")
    assert classify(reply, "sender.test") == {"type": "reply", "email": "buyer@example.com", "messageId": "m1@example"}
    automatic = email.message_from_string("From: buyer@example.com\nSubject: Away\nAuto-Submitted: auto-replied\n\n")
    assert classify(automatic, "sender.test")["type"] == "auto_reply"
    own = email.message_from_string("From: sender@sender.test\nSubject: Re: Quote\nIn-Reply-To: <m1@example>\n\n")
    assert classify(own, "sender.test") is None
    summary = mailbox_message(b"From: Buyer <buyer@example.net>\nTo: sender@sender.test\nSubject: Hello\nMessage-ID: <x@example>\n\nBody", "sender@sender.test", 7, "1")
    assert summary["from"]["address"] == "buyer@example.net" and summary["bodyText"] == "Body" and summary["unread"]
    print("SELF_TEST=OK")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--lookback", type=int, default=0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    counts = poll(dry_run=args.dry_run, lookback=max(0, args.lookback))
    print(json.dumps(dict(counts), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
