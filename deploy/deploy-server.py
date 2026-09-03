from __future__ import annotations

import json
import os
import re
import sys
import uuid
from pathlib import Path

import paramiko


ROOT = Path(__file__).resolve().parents[1]
REMOTE_ROOT = "/opt/dakings-prospect-ops"
CREDENTIALS = Path(os.environ.get("DAKINGS_DEPLOY_CREDENTIALS", ROOT / "公网ip和账号密码.txt"))
KNOWN_HOSTS = Path(os.environ.get("DAKINGS_DEPLOY_KNOWN_HOSTS", ROOT / ".codex_work" / "known_hosts"))
MAILBOX_AUTH_DIR = Path(os.environ.get("DAKINGS_MAILBOX_AUTH_DIR", ROOT / "deploy"))

PROJECT_FILES = (
    "app/server.mjs",
    "app/company-qualification.mjs",
    "app/company-processing-strategy.mjs",
    "app/keyword-collection.mjs",
    "app/pipeline-worker.mjs",
    "app/contact-collection.mjs",
    "app/public/app.js",
    "app/public/index.html",
    "app/public/styles.css",
    "app/public/tokens.css",
    "app/public/assets/fonts/inter-latin-400-600.woff2",
    "app/public/assets/fonts/jetbrains-mono-latin-400-600.woff2",
    "app/public/assets/fonts/space-grotesk-latin-500-700.woff2",
    "app/tests/smoke.mjs",
    "app/tests/contact-collection-unit.mjs",
    "app/tests/company-qualification-unit.mjs",
    "app/tests/company-processing-strategy-unit.mjs",
    "app/tests/mobile-responsive-unit.mjs",
    "app/tests/keyword-collection-unit.mjs",
    "app/tests/feature-integration-unit.mjs",
    "app/tests/mailbox-export-unit.mjs",
    "app/tests/pipeline-worker-unit.mjs",
    "app/tests/deployment-contract-unit.mjs",
    "app/tests/managed-hscode-plan-unit.mjs",
    "app/tests/reprocess-managed-history-unit.mjs",
    "app/data/email-template-library.json",
    "app/data/managed-history-report.json",
    "app/README.md",
    "app/.env.example",
    "deploy/assert-isolation.sh",
    "deploy/backup.sh",
    "deploy/restore.sh",
    "deploy/healthcheck.sh",
    "deploy/update-systemd.sh",
    "deploy/compose.yaml",
    "deploy/Dockerfile",
    "deploy/nginx-prospect-ops.conf",
    "deploy/HTTPS_STATUS.md",
    "deploy/README.md",
    "deploy/CIRCUIT_RECOVERY.md",
    "deploy/INCIDENTS.md",
    "deploy/.env.runtime.example",
    "deploy/deploy-server.py",
    "deploy/one-click-deploy.ps1",
    "deploy/requirements-deploy.txt",
    "deploy/dakings-prospect-ops.service",
    "deploy/dakings-pipeline-worker.service",
    "deploy/dakings-pipeline-worker.timer",
    "deploy/dakings-prospect-ops-backup.service",
    "deploy/dakings-prospect-ops-backup.timer",
    "deploy/dakings-prospect-ops-healthcheck.service",
    "deploy/dakings-prospect-ops-healthcheck.timer",
    "deploy/dakings-imap-feedback.service",
    "deploy/dakings-imap-feedback.timer",
    "deploy/dakings-netease-browser.service",
    "deploy/dakings-managed-collection.service",
    "deploy/dakings-managed-collection.timer",
    "deploy/install-netease-browser.sh",
    "tools/imap-feedback-poller.py",
    "tools/netease-cdp-client.mjs",
    "tools/netease-hscode-discovery.mjs",
    "tools/netease-keyword-discovery.mjs",
    "tools/netease-country-business-discovery.mjs",
    "tools/netease-playwright-search.mjs",
    "tools/run-netease-contact-queue.mjs",
    "tools/netease-contact-supervisor.mjs",
    "tools/managed-hscode-plan.mjs",
    "tools/run-managed-hscode-plan.mjs",
    "tools/handoff-managed-pipeline.py",
    "tools/reprocess-managed-history.mjs",
    "tools/install-managed-hscode-task.ps1",
    "tools/run-managed-hscode-plan.ps1",
    "tools/run-managed-preflight.py",
    "tools/sync-managed-plan.py",
    "tools/start-netease-collection-runtime.ps1",
    "tools/server-netease-login.py",
    "plans/managed-hscode-plan.json",
)

SYSTEMD_FILES = (
    "dakings-prospect-ops.service",
    "dakings-pipeline-worker.service",
    "dakings-pipeline-worker.timer",
    "dakings-prospect-ops-backup.service",
    "dakings-prospect-ops-backup.timer",
    "dakings-prospect-ops-healthcheck.service",
    "dakings-prospect-ops-healthcheck.timer",
    "dakings-imap-feedback.service",
    "dakings-imap-feedback.timer",
    "dakings-managed-collection.service",
    "dakings-managed-collection.timer",
)


def credentials() -> tuple[str, str, str]:
    if not CREDENTIALS.is_file():
        raise RuntimeError(f"缺少本机部署凭据文件：{CREDENTIALS}")
    lines = [line.strip() for line in CREDENTIALS.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if len(lines) < 3:
        raise RuntimeError("部署凭据文件格式应为：IP、账号、密码三行")
    host_match = re.search(r"(?:\d{1,3}\.){3}\d{1,3}", lines[0])
    if not host_match:
        raise RuntimeError("部署凭据文件中缺少服务器IP")
    username = re.split(r"[:=：]", lines[1], maxsplit=1)[-1].strip()
    password = re.split(r"[:=：]", lines[2], maxsplit=1)[-1].strip()
    if not username or not password:
        raise RuntimeError("部署账号或密码为空")
    return host_match.group(0), username, password


def run(client: paramiko.SSHClient, command: str, label: str) -> str:
    stdin, stdout, stderr = client.exec_command(command, timeout=180)
    del stdin
    output = stdout.read().decode("utf-8", errors="replace").strip()
    error = stderr.read().decode("utf-8", errors="replace").strip()
    status = stdout.channel.recv_exit_status()
    print(f"[{label}] exit={status}")
    if output:
        print(output)
    if error:
        print(error, file=sys.stderr)
    if status != 0:
        raise RuntimeError(f"{label}失败")
    return output


def upload_atomic(sftp: paramiko.SFTPClient, local: Path, remote: str, mode: int = 0o644) -> None:
    temporary = f"{remote}.upload-{uuid.uuid4().hex}"
    if local.suffix == ".sh":
        # Keep POSIX entrypoints executable after uploads from Windows.
        payload = local.read_bytes().replace(b"\r\n", b"\n")
        with sftp.open(temporary, "wb") as stream:
            stream.write(payload)
    else:
        sftp.put(str(local), temporary)
    sftp.chmod(temporary, mode)
    sftp.posix_rename(temporary, remote)
    print(f"[upload] {local.relative_to(ROOT)}")


def parse_env(text: str) -> dict[str, str]:
    values = {}
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def upload_mailbox_accounts(sftp: paramiko.SFTPClient) -> None:
    with sftp.open(f"{REMOTE_ROOT}/deploy/.env.runtime", "r") as stream:
        runtime = parse_env(stream.read().decode("utf-8"))
    accounts = [{"address": runtime.get("SMTP_USER", ""), "password": runtime.get("SMTP_PASS", "")}]
    for number in range(2, 11):
        path = MAILBOX_AUTH_DIR / f".env.maggie{number}.auth"
        if not path.is_file():
            raise RuntimeError(f"缺少受限邮箱凭据文件：{path.name}")
        values = parse_env(path.read_text(encoding="utf-8"))
        accounts.append({"address": values.get("SMTP_USER", ""), "password": values.get("SMTP_PASS", "")})
    expected = {f"maggie{number}@{'dakingscc.cc' if number <= 5 else 'dakingscc.cn'}" for number in range(1, 11)}
    actual = {item["address"].lower() for item in accounts if item["address"] and item["password"]}
    if actual != expected:
        raise RuntimeError("十账号邮箱凭据不完整或账号归属不匹配")
    payload = json.dumps({
        "version": 1,
        "accounts": [{
            **item,
            "enabled": True,
            "imapHost": "imap.qiye.aliyun.com",
            "imapPort": 993,
            "smtpHost": "smtp.qiye.aliyun.com",
            "smtpPort": 465,
            "smtpSecure": True,
        } for item in accounts],
    }, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    remote = f"{REMOTE_ROOT}/deploy/mailbox-accounts.json"
    temporary = f"{remote}.upload-{uuid.uuid4().hex}"
    with sftp.open(temporary, "wb") as stream:
        stream.write(payload)
    sftp.chmod(temporary, 0o600)
    sftp.posix_rename(temporary, remote)
    print("[upload] mailbox-accounts.json (10 accounts, secrets redacted)")


def update_remote_runtime(sftp: paramiko.SFTPClient, updates: dict[str, str]) -> None:
    remote = f"{REMOTE_ROOT}/deploy/.env.runtime"
    with sftp.open(remote, "r") as stream:
        lines = stream.read().decode("utf-8").splitlines()
    replaced = set()
    output = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else ""
        if key in updates:
            output.append(f"{key}={updates[key]}")
            replaced.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in updates.items() if key not in replaced)
    temporary = f"{remote}.upload-{uuid.uuid4().hex}"
    with sftp.open(temporary, "wb") as stream:
        stream.write(("\n".join(output).rstrip() + "\n").encode("utf-8"))
    sftp.chmod(temporary, 0o600)
    sftp.posix_rename(temporary, remote)
    print(f"[runtime] updated {len(updates)} non-secret mailbox settings")


def project_manifest() -> dict[Path, str]:
    manifest = {ROOT / relative: f"{REMOTE_ROOT}/{relative.replace(os.sep, '/')}" for relative in PROJECT_FILES}
    for asset in sorted((ROOT / "app" / "public" / "assets" / "email").glob("*")):
        if asset.is_file():
            manifest[asset] = f"{REMOTE_ROOT}/app/public/assets/email/{asset.name}"
    missing = [str(path.relative_to(ROOT)) for path in manifest if not path.is_file()]
    if missing:
        raise RuntimeError(f"部署清单缺少文件：{', '.join(missing)}")
    return manifest


def main() -> None:
    if not KNOWN_HOSTS.is_file():
        raise RuntimeError(f"缺少已核验的SSH主机指纹文件：{KNOWN_HOSTS}")
    host, username, password = credentials()
    manifest = project_manifest()
    client = paramiko.SSHClient()
    client.load_host_keys(str(KNOWN_HOSTS))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        hostname=host,
        username=username,
        password=password,
        look_for_keys=False,
        allow_agent=False,
        timeout=15,
        auth_timeout=15,
    )
    try:
        run(
            client,
            f"test -f {REMOTE_ROOT}/deploy/.env.runtime && test -f {REMOTE_ROOT}/deploy/source/source.json && "
            "printf 'ready\\n'; id -u; node --version; systemctl is-active dakings-prospect-ops.service",
            "connect",
        )
        run(client, f"cd {REMOTE_ROOT}/deploy && ./backup.sh", "backup")
        run(
            client,
            "cp /etc/nginx/conf.d/dakings-prospect-ops.conf "
            "/etc/nginx/conf.d/dakings-prospect-ops.conf.predeploy",
            "backup-nginx",
        )
        run(
            client,
            f"mkdir -p {REMOTE_ROOT}/app/public/assets/email {REMOTE_ROOT}/app/public/assets/fonts {REMOTE_ROOT}/app/tests {REMOTE_ROOT}/tools {REMOTE_ROOT}/plans "
            f"{REMOTE_ROOT}/.codex_work {REMOTE_ROOT}/outputs {REMOTE_ROOT}/tmp "
            f"{REMOTE_ROOT}/deploy/runtime-data/pipeline-inputs {REMOTE_ROOT}/deploy/runtime-data/pipeline-artifacts && "
            f"chown -R prospectops:prospectops {REMOTE_ROOT}/.codex_work {REMOTE_ROOT}/outputs {REMOTE_ROOT}/tmp {REMOTE_ROOT}/deploy/runtime-data/pipeline-inputs "
            f"{REMOTE_ROOT}/deploy/runtime-data/pipeline-artifacts",
            "prepare-directories",
        )
        with client.open_sftp() as sftp:
            upload_mailbox_accounts(sftp)
            update_remote_runtime(sftp, {
                "MAILBOX_REPLY_ENABLED": "true",
                "MAILBOX_REPLY_DAILY_LIMIT": "50",
                "SEND_BATCH_LIMIT": "500",
                "SEND_DAILY_LIMIT": "500",
                "SEND_ACCOUNT_DAILY_LIMIT": "50",
                "OPS_ALERT_EMAIL": "18395655269@163.com",
            })
            for local, remote in manifest.items():
                mode = 0o755 if local.suffix == ".sh" else 0o644
                upload_atomic(sftp, local, remote, mode)
            for name in SYSTEMD_FILES:
                upload_atomic(sftp, ROOT / "deploy" / name, f"/etc/systemd/system/{name}")
            upload_atomic(
                sftp,
                ROOT / "deploy" / "nginx-prospect-ops.conf",
                "/etc/nginx/conf.d/dakings-prospect-ops.conf",
            )
        run(client, f"chown prospectops:prospectops {REMOTE_ROOT}/deploy/mailbox-accounts.json && chmod 600 {REMOTE_ROOT}/deploy/mailbox-accounts.json", "mailbox-credentials")
        browser_state = run(
            client,
            "systemctl is-active dakings-netease-browser.service 2>/dev/null || true",
            "netease-browser-state",
        ).strip()
        if browser_state == "active":
            print("[netease-browser] already active; skipped install/restart to preserve login session")
        else:
            run(client, f"cd {REMOTE_ROOT}/deploy && ./install-netease-browser.sh", "netease-browser")

        run(
            client,
            "if nginx -t; then systemctl reload nginx.service; rm -f /etc/nginx/conf.d/dakings-prospect-ops.conf.predeploy; "
            "else mv /etc/nginx/conf.d/dakings-prospect-ops.conf.predeploy /etc/nginx/conf.d/dakings-prospect-ops.conf; "
            "nginx -t; exit 1; fi",
            "nginx",
        )
        run(
            client,
            f"cd {REMOTE_ROOT}/deploy && latest=$(ls -1t backups/runtime-data-*.tar.gz | head -n 1) && "
            "./restore.sh --verify \"$latest\"",
            "restore-verify",
        )

        run(
            client,
            f"node --check {REMOTE_ROOT}/app/server.mjs && node --check {REMOTE_ROOT}/app/pipeline-worker.mjs && "
            f"node --check {REMOTE_ROOT}/app/public/app.js && node --check {REMOTE_ROOT}/tools/managed-hscode-plan.mjs && "
            f"node --check {REMOTE_ROOT}/tools/netease-keyword-discovery.mjs && "
            f"node --check {REMOTE_ROOT}/tools/netease-country-business-discovery.mjs && "
            f"node --check {REMOTE_ROOT}/app/keyword-collection.mjs && "
            f"python3 -m py_compile {REMOTE_ROOT}/tools/imap-feedback-poller.py",
            "syntax",
        )
        run(
            client,
            f"cd {REMOTE_ROOT} && node app/tests/company-qualification-unit.mjs && node app/tests/pipeline-worker-unit.mjs && node app/tests/managed-hscode-plan-unit.mjs && "
            f"node app/tests/deployment-contract-unit.mjs && "
            f"node app/tests/mobile-responsive-unit.mjs && "
            f"node app/tests/keyword-collection-unit.mjs && "
            f"SOURCE_PATH={REMOTE_ROOT}/deploy/source/source.json node app/tests/smoke.mjs",
            "smoke",
        )
        run(
            client,
            "systemctl daemon-reload && "
            "systemctl enable --now dakings-pipeline-worker.timer dakings-prospect-ops-backup.timer "
            "dakings-prospect-ops-healthcheck.timer dakings-imap-feedback.timer && "
            "systemctl restart dakings-prospect-ops.service && "
            "for i in $(seq 1 30); do curl -fs http://127.0.0.1:4173/api/health >/tmp/prospect-health.json && break; sleep 1; done && "
            "node -e \"const h=require('/tmp/prospect-health.json'); if(!h.ok||!h.delivery?.interventionAlert?.configured||!h.localControls.pipelineJobs) process.exit(1); console.log(JSON.stringify({ok:h.ok,model:h.ai.model,aiReachable:h.ai.reachable,sendingEnabled:h.sendingEnabled,deliveryCircuit:h.delivery.circuit,interventionAlert:h.delivery.interventionAlert,feedback:h.feedback,localControls:h.localControls}))\"",
            "restart-health",
        )
        before = run(
            client,
            "curl -fsS http://127.0.0.1:4173/api/pipeline | node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({jobs:p.jobs.length,waiting_input:p.counts.waiting_input,claimable:p.claimable}))})\"",
            "pipeline-before-restart",
        )
        run(client, "systemctl restart dakings-prospect-ops.service && sleep 2 && curl -fsS http://127.0.0.1:4173/api/health >/dev/null", "restart-recovery")
        after = run(
            client,
            "curl -fsS http://127.0.0.1:4173/api/pipeline | node -e \"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({jobs:p.jobs.length,waiting_input:p.counts.waiting_input,claimable:p.claimable}))})\"",
            "pipeline-after-restart",
        )
        if json.loads(before.splitlines()[-1]) != json.loads(after.splitlines()[-1]):
            raise RuntimeError("重启前后流水线摘要不一致")
        run(
            client,
            f"test -f {REMOTE_ROOT}/deploy/runtime-data/pipeline.json && test -f {REMOTE_ROOT}/deploy/runtime-data/outbox.json && "
            f"test -f {REMOTE_ROOT}/deploy/runtime-data/runtime-state.json && "
            f"stat -c '%U:%G %a %n' {REMOTE_ROOT}/deploy/runtime-data/pipeline.json "
            f"{REMOTE_ROOT}/deploy/runtime-data/outbox.json {REMOTE_ROOT}/deploy/runtime-data/runtime-state.json",
            "runtime-files",
        )
        run(
            client,
            "systemctl start dakings-prospect-ops-healthcheck.service || true; "
            "systemctl show dakings-prospect-ops-healthcheck.service -p Result -p ExecMainStatus; "
            "test \"$(systemctl show dakings-prospect-ops-healthcheck.service -p Result --value)\" = success && "
            "systemctl is-active dakings-pipeline-worker.timer dakings-prospect-ops-backup.timer "
            "dakings-prospect-ops-healthcheck.timer dakings-imap-feedback.timer",
            "ops-healthcheck",
        )
        run(
            client,
            "systemctl start dakings-imap-feedback.service; "
            "systemctl show dakings-imap-feedback.service -p Result -p ExecMainStatus; "
            "curl -fsS http://127.0.0.1:4173/api/mailbox >/tmp/prospect-mailbox.json; "
            "node -e \"const m=require('/tmp/prospect-mailbox.json'); if(!m.configured||!m.replyEnabled||m.accounts.length!==10||m.counts.synced!==10||JSON.stringify(m).includes('password')) process.exit(1); console.log(JSON.stringify({accounts:m.counts.accounts,synced:m.counts.synced,messages:m.counts.messages,unread:m.counts.unread,replyEnabled:m.replyEnabled,replyRemaining:m.replyUsage.remaining}))\"; "
            f"stat -c '%U:%G %a %n' {REMOTE_ROOT}/deploy/mailbox-accounts.json {REMOTE_ROOT}/deploy/runtime-data/mailboxes.json",
            "mailbox-sync",
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()
