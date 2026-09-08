from __future__ import annotations

import base64
import importlib.util
import shlex
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".codex_work" / "python_deps"))


def load_handoff():
    spec = importlib.util.spec_from_file_location("handoff", ROOT / "tools" / "handoff-managed-pipeline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    qr_mode = "--qr" in sys.argv[1:]
    output_arg = next((item for item in sys.argv[1:] if item != "--qr"), None)
    output = Path(output_arg or ROOT / ".codex_work" / "server-netease.png").resolve()
    remote_path = "/opt/dakings-prospect-ops/browser-runtime/diagnostic.png"
    script = """const {chromium}=require('/opt/dakings-prospect-ops/browser-runtime/node_modules/playwright-core');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9224');const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('waimao.office.163.com'));if(!p)throw new Error('NetEase page missing');if(await p.locator('input[type=password]').evaluateAll(xs=>xs.some(x=>Boolean(x.value))))throw new Error('Refusing screenshot with a populated password');if(%s){const sw=p.locator('[data-test-id="login-method-switch"]:visible').first();await sw.waitFor({timeout:30000});await sw.click();await p.waitForTimeout(1200);const media=p.locator('canvas:visible, img:visible');const index=await media.evaluateAll(xs=>xs.findIndex(x=>{const r=x.getBoundingClientRect();return r.width>=140&&r.width<=320&&r.height>=140&&r.height<=320&&Math.abs(r.width-r.height)<20}));if(index<0)throw new Error('Fresh QR element not found');await media.nth(index).screenshot({path:'%s'});}else{await p.screenshot({path:'%s',fullPage:true});}await b.close()})().catch(e=>{console.error(e);process.exit(1)})""" % ("true" if qr_mode else "false", remote_path, remote_path)
    encoded = base64.b64encode(script.encode("ascii")).decode("ascii")
    node_expression = f"eval(Buffer.from('{encoded}','base64').toString())"
    command = f"runuser -u prospectops -- node -e {shlex.quote(node_expression)}"
    remote = load_handoff().Remote()
    try:
        remote.command(command, timeout=90)
        output.parent.mkdir(parents=True, exist_ok=True)
        with remote.client.open_sftp() as sftp:
            sftp.get(remote_path, str(output))
            sftp.remove(remote_path)
        print(output)
    finally:
        remote.command(f"rm -f {shlex.quote(remote_path)}", timeout=30)
        remote.close()


if __name__ == "__main__":
    main()
