"""Validate candidate contact domains through the server API; never sends mail."""
import argparse
import hashlib
import importlib.util
import json
import posixpath
import shlex
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOTE_ROOT = "/opt/dakings-prospect-ops"


def digest(value):
    return hashlib.sha256(str(value or "").strip().lower().encode()).hexdigest()


def norm(value):
    return " ".join(str(value or "").lower().split())


def main():
    parser = argparse.ArgumentParser(description="Server-side DNS/MX validation audit (no SMTP)")
    parser.add_argument("--per-company", type=int, default=10)
    parser.add_argument("--limit", type=int, default=254)
    args = parser.parse_args()
    if args.per_company < 1 or args.limit < 1:
        parser.error("--per-company and --limit must be at least 1")

    spec = importlib.util.spec_from_file_location("deploy", ROOT / "deploy" / "deploy-server.py")
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    host, user, password = deploy.credentials()
    import paramiko
    ssh = paramiko.SSHClient()
    ssh.load_host_keys(str(deploy.KNOWN_HOSTS))
    ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    ssh.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False, timeout=15)
    try:
        def read(path):
            with ssh.open_sftp() as sftp, sftp.open(path, "r") as handle:
                return json.load(handle)

        runtime = f"{REMOTE_ROOT}/deploy/runtime-data"
        pipeline = read(f"{runtime}/pipeline.json")
        outbox = read(f"{runtime}/outbox.json")
        suppressions = read(f"{runtime}/suppressions.json")
        active = {e.get("recipientHash") for e in outbox.get("entries", []) if e.get("status") in {"pending", "sending", "accepted", "uncertain"}}
        suppressed = {e.get("emailHash") for e in suppressions.get("records", [])}
        candidates, seen, company_counts = [], set(), defaultdict(int)
        for job in pipeline.get("jobs", []):
            refs = [a.get("reference", "") for a in job.get("artifacts", []) if a.get("stage") == "drafting"]
            if not refs or not refs[-1].startswith("file://"):
                continue
            artifact = read(refs[-1].removeprefix("file://"))
            for draft in artifact.get("drafts", []):
                email = str(draft.get("email", "")).strip().lower()
                company = norm(draft.get("company"))
                fingerprint = digest(email)
                if not email or fingerprint in seen or fingerprint in active or fingerprint in suppressed or not company:
                    continue
                if company_counts[company] >= args.per_company:
                    continue
                seen.add(fingerprint)
                company_counts[company] += 1
                candidates.append(email)
                if len(candidates) >= args.limit:
                    break
            if len(candidates) >= args.limit:
                break

        results = []
        for start in range(0, len(candidates), 25):
            payload = json.dumps({"emails": candidates[start:start + 25], "mode": "domain"}, separators=(",", ":"))
            command = f"curl -fsS -X POST -H 'Content-Type: application/json' --data {shlex.quote(payload)} http://127.0.0.1:4173/api/contact-quality/validate"
            _, stdout, stderr = ssh.exec_command(command, timeout=90)
            raw = stdout.read().decode("utf-8", errors="replace")
            if stdout.channel.recv_exit_status():
                raise RuntimeError(stderr.read().decode("utf-8", errors="replace") or "validation request failed")
            results.extend(json.loads(raw).get("results", []))
        print(json.dumps({"smtp": False, "outboxCreated": 0, "requested": len(candidates), "processed": len(results), "statuses": dict(Counter(item.get("status", "unknown") for item in results)), "note": "DNS/MX evidence only; no contact was promoted to deliverable without explicit evidence"}, ensure_ascii=False, indent=2))
    finally:
        ssh.close()


if __name__ == "__main__":
    main()
