from __future__ import annotations

import importlib.util
import json
import shlex
import sys
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".codex_work" / "python_deps"))


def load_handoff():
    spec = importlib.util.spec_from_file_location("handoff", ROOT / "tools" / "handoff-managed-pipeline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    credential = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "网易外贸通.txt").resolve()
    if ROOT not in credential.parents or not credential.is_file():
        raise RuntimeError("网易凭据文件必须位于项目目录内")
    remote = load_handoff().Remote()
    temporary = f"/opt/dakings-prospect-ops/browser-runtime/.login-{uuid.uuid4().hex}"
    try:
        with remote.client.open_sftp() as sftp:
            sftp.put(str(credential), temporary)
            sftp.chmod(temporary, 0o600)
        remote.command(f"chown prospectops:prospectops {shlex.quote(temporary)}")
        command = (
            "cd /opt/dakings-prospect-ops && "
            "runuser -u prospectops -- env "
            "EDGE_CDP_ENDPOINT=http://127.0.0.1:9224 "
            "WS_MODULE=/opt/dakings-prospect-ops/browser-runtime/node_modules/ws "
            f"node tools/netease-cdp-client.mjs login-from-file {shlex.quote(temporary)}"
        )
        _, stdout, stderr = remote.client.exec_command(command, timeout=150)
        output = stdout.read().decode("utf-8", errors="replace")
        error = stderr.read().decode("utf-8", errors="replace").strip()
        status = stdout.channel.recv_exit_status()
        if status not in (0, 3):
            raise RuntimeError(error or f"远端登录失败：{status}")
        result = json.loads(output)
        print(json.dumps({"status": result.get("status"), "url": result.get("url", "")}, ensure_ascii=False))
        if status:
            raise SystemExit(status)
    finally:
        remote.command(f"rm -f {shlex.quote(temporary)}", timeout=30)
        remote.close()


if __name__ == "__main__":
    main()
