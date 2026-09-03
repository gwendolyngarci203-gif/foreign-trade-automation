import argparse
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

try:
    import paramiko
except ModuleNotFoundError:
    paramiko = None


ROOT = Path(__file__).resolve().parents[1]
REMOTE_ROOT = "/opt/dakings-prospect-ops"
API_BASE = "http://127.0.0.1:4173"


def load_deploy_module():
    spec = importlib.util.spec_from_file_location("dakings_deploy", ROOT / "deploy" / "deploy-server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_artifact(file: str, kind: str, hs_code: str):
    path = Path(file).resolve()
    if ROOT not in path.parents or not path.is_file():
        raise RuntimeError(f"输入文件不在项目目录内：{path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if kind == "discovery":
        if payload.get("kind") not in {"netease-customs-discovery", "netease-keyword-discovery", "netease-country-business-discovery"}:
            raise RuntimeError("输入文件不是受支持的网易 discovery artifact")
    elif payload.get("kind") != kind:
        raise RuntimeError(f"输入文件类型应为 {kind}")
    artifact_hs_code = str(payload.get("query") or payload.get("hsCode") or "")
    if hs_code and artifact_hs_code and artifact_hs_code != hs_code:
        raise RuntimeError(f"输入文件 HSCode 与计划不一致：{artifact_hs_code}")
    if not isinstance(payload.get("records"), list) or not payload["records"]:
        raise RuntimeError("输入文件没有 records")
    return path, payload


class Remote:
    def __init__(self):
        if paramiko is None:
            raise RuntimeError("远程交接缺少 paramiko；服务器本机执行请使用 --local")
        deploy = load_deploy_module()
        host, username, password = deploy.credentials()
        self.client = paramiko.SSHClient()
        self.client.load_host_keys(str(deploy.KNOWN_HOSTS))
        self.client.set_missing_host_key_policy(paramiko.RejectPolicy())
        self.client.connect(
            host,
            username=username,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            timeout=15,
            auth_timeout=15,
        )

    def close(self):
        self.client.close()

    def command(self, command: str, stdin_payload: str = "", timeout: int = 180) -> str:
        stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        if stdin_payload:
            stdin.write(stdin_payload)
            stdin.channel.shutdown_write()
        output = stdout.read().decode("utf-8", errors="replace")
        error = stderr.read().decode("utf-8", errors="replace").strip()
        status = stdout.channel.recv_exit_status()
        if status:
            raise RuntimeError(error or f"远端命令失败：{status}")
        return output

    def api(self, method: str, pathname: str, body=None):
        command = f"curl -fsS -X {shlex.quote(method)}"
        payload = ""
        if body is not None:
            command += " -H 'Content-Type: application/json' --data-binary @-"
            payload = json.dumps(body, ensure_ascii=False)
        command += f" {shlex.quote(API_BASE + pathname)}"
        return json.loads(self.command(command, payload, timeout=60))

    def upload(self, local: Path, remote_relative: str):
        remote = posixpath.join(REMOTE_ROOT, "deploy", "runtime-data", "pipeline-inputs", remote_relative)
        directory = posixpath.dirname(remote)
        temporary = f"{remote}.upload-{uuid.uuid4().hex}"
        self.command(f"mkdir -p {shlex.quote(directory)} && chown prospectops:prospectops {shlex.quote(directory)}")
        with self.client.open_sftp() as sftp:
            sftp.put(str(local), temporary)
            sftp.chmod(temporary, 0o600)
            sftp.posix_rename(temporary, remote)
        self.command(f"chown prospectops:prospectops {shlex.quote(remote)} && chmod 600 {shlex.quote(remote)}")

    def run_worker(self):
        self.command("systemctl start dakings-pipeline-worker.service", timeout=35 * 60)


class Local:
    def close(self):
        pass

    def api(self, method: str, pathname: str, body=None):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            API_BASE + pathname,
            data=payload,
            method=method,
            headers={"Content-Type": "application/json"} if payload else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"本机 API {pathname} 失败：{error.code} {detail}") from error

    def upload(self, local: Path, remote_relative: str):
        relative = Path(*remote_relative.split("/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("流水线输入路径越界")
        root = Path(os.environ.get("PIPELINE_INPUT_ROOT", ROOT / "deploy" / "runtime-data" / "pipeline-inputs")).resolve()
        destination = (root / relative).resolve()
        if root not in destination.parents:
            raise RuntimeError("流水线输入路径越界")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f"{destination.name}.upload-{uuid.uuid4().hex}")
        shutil.copyfile(local, temporary)
        os.chmod(temporary, 0o600)
        temporary.replace(destination)

    def run_worker(self):
        result = subprocess.run(
            [os.environ.get("NODE_EXE", "/usr/bin/node"), str(ROOT / "app" / "pipeline-worker.mjs"), "--drain", "--max-jobs", "6"],
            cwd=ROOT,
            timeout=35 * 60,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "本机流水线 worker 失败").strip())


def select_page_job(jobs, task_id, page_token):
    for job in jobs:
        references = [job.get("inputReference", ""), *(item.get("reference", "") for item in job.get("artifacts", []))]
        if job.get("operationTaskId") == task_id and any(page_token in str(reference) for reference in references):
            return job
    return None


def get_job(remote, job_id):
    pipeline = remote.api("GET", "/api/pipeline")
    job = next((item for item in pipeline.get("jobs", []) if item.get("id") == job_id), None)
    if not job:
        raise RuntimeError(f"服务器流水线任务消失：{job_id}")
    return job


def completed_handoff(job):
    return job.get("currentStage") == "feedback" and job.get("status") == "waiting_input"


def find_or_create_page_job(remote, task_id, page_token):
    pipeline = remote.api("GET", "/api/pipeline")
    jobs = pipeline.get("jobs", [])
    unassigned = next((job for job in jobs if job.get("operationTaskId") == task_id
                       and job.get("currentStage") == "discovery" and job.get("status") == "waiting_input"
                       and not job.get("inputReference") and not job.get("artifacts")), None)
    return select_page_job(jobs, task_id, page_token) or unassigned or remote.api(
        "POST", "/api/pipeline/jobs", {"operationTaskId": task_id}
    )


def self_test():
    jobs = [
        {"id": "old", "operationTaskId": "task", "inputReference": "managed/plan/page-009/contact.json", "artifacts": []},
        {"id": "new", "operationTaskId": "task", "inputReference": "", "artifacts": [{"reference": "managed/plan/page-010/discovery.json"}]},
    ]
    assert select_page_job(jobs, "task", "/page-010/")["id"] == "new"
    assert select_page_job(jobs, "task", "/page-011/") is None
    assert select_page_job(jobs, "task", "/page-010/handoff-batch-b/") is None
    assert completed_handoff({"currentStage": "feedback", "status": "waiting_input"})
    assert not completed_handoff({"currentStage": "approval", "status": "batch_review"})
    print(json.dumps({"ok": True, "check": "page_job_selection_and_completed_handoff"}))


def main():
    parser = argparse.ArgumentParser(description="将本地已验证网易产物安全交给服务器 AI 流水线")
    parser.add_argument("discovery")
    parser.add_argument("enrichment", nargs="?")
    parser.add_argument("--plan", default="plans/managed-hscode-plan.json")
    parser.add_argument("--simulate-send", action="store_true", help="记录发送预演，不批准、不写 outbox、不连接 SMTP")
    parser.add_argument("--local", action="store_true", help="在服务器本机通过 127.0.0.1 API 交接")
    args = parser.parse_args()

    plan = json.loads((ROOT / args.plan).read_text(encoding="utf-8"))
    collection_mode = plan.get("collectionMode", "hscode")
    if collection_mode == "country_business":
        hs_code = ""
    else:
        if len(plan.get("hsCodes", [])) != 1:
            raise RuntimeError("当前交接工具要求计划只含一个 HSCode")
        hs_code = str(plan["hsCodes"][0]["hsCode"])
    discovery_path, discovery = read_artifact(args.discovery, "discovery", hs_code)
    if not args.enrichment and collection_mode == "country_business":
        page_number = int(discovery.get("source", {}).get("pageNumber") or discovery.get("pagination", {}).get("pageNumber") or 1)
        identity = re.sub(r"[^a-zA-Z0-9_-]", "-", f"country-{discovery.get('country')}-{discovery.get('query')}")[:120]
        folder = f"managed/{plan['planId']}/{identity}/page-{page_number:03d}/discovery-only"
        discovery_reference = f"{folder}/discovery.json"
        remote = Local() if args.local else Remote()
        try:
            tasks = remote.api("GET", "/api/ops/tasks").get("items", [])
            task = next((item for item in tasks if item.get("collectionMode") == "country_business"
                         and item.get("country") == discovery.get("country")
                         and item.get("automation", {}).get("planId") == plan["planId"]), None)
            if not task:
                raise RuntimeError("服务器缺少对应 country_business 托管计划任务")
            remote.upload(discovery_path, discovery_reference)
            job = find_or_create_page_job(remote, task["id"], f"/{folder.split('/', 1)[1]}/")
            if job.get("currentStage") == "discovery" and job.get("status") == "waiting_input":
                remote.api("POST", f"/api/pipeline/jobs/{job['id']}/resume", {"inputReference": discovery_reference})
                remote.run_worker()
            print(json.dumps({"ok": True, "mode": "country_business", "jobId": job["id"], "stage": "discovery", "inputReference": discovery_reference}))
            return
        finally:
            remote.close()
    if not args.enrichment:
        raise RuntimeError("缺少联系人 enrichment artifact")
    enrichment_path, enrichment = read_artifact(args.enrichment, "netease-contact-enrichment", hs_code)
    page_number = int(discovery.get("source", {}).get("pageNumber") or discovery.get("pagination", {}).get("pageNumber") or 1)
    if page_number < 1 or int(enrichment.get("pageNumber") or page_number) != page_number:
        raise RuntimeError("发现与联系人产物页码不一致")
    handoff_key = re.sub(r"[^a-zA-Z0-9_-]", "-", str(enrichment.get("handoffKey") or "full-page"))[:80]
    if not handoff_key:
        raise RuntimeError("联系人产物缺少有效 handoffKey")

    identity = f"country-{discovery.get('country')}-{discovery.get('query')}" if collection_mode == "country_business" else f"hscode-{hs_code}"
    identity = re.sub(r"[^a-zA-Z0-9_-]", "-", identity)[:120]
    folder = f"managed/{plan['planId']}/{identity}/page-{page_number:03d}/handoff-{handoff_key}"
    page_token = f"/{folder.split('/', 1)[1]}/"
    discovery_reference = f"{folder}/discovery.json"
    enrichment_reference = f"{folder}/contact-enrichment.json"
    remote = Local() if args.local else Remote()
    try:
        health = remote.api("GET", "/api/health")
        if not health.get("ai", {}).get("configured"):
            raise RuntimeError("服务器 AI 未配置")
        if health.get("delivery", {}).get("circuit", {}).get("open"):
            raise RuntimeError("服务器发送熔断已开启，停止交接")
        if health.get("delivery", {}).get("allowUnverified"):
            raise RuntimeError("服务器意外允许未验证收件人，停止交接")

        tasks = remote.api("GET", "/api/ops/tasks").get("items", [])
        task = next((item for item in tasks if item.get("collectionMode", "hscode") == collection_mode
                     and (collection_mode != "country_business" or item.get("country") == discovery.get("country"))
                     and (collection_mode == "country_business" or item.get("hsCode") == hs_code)
                     and item.get("automation", {}).get("planId") == plan["planId"]), None)
        if not task:
            raise RuntimeError("服务器缺少对应托管计划任务")

        company_count = int(enrichment.get("counts", {}).get("companiesProcessed")
                            or plan["dailyBudgets"]["companyDetails"])
        action_base = f"{plan['planId']}:{identity}:page:{page_number}:handoff:{handoff_key}"
        actions = [
            {"type": "buyer_entry", "count": len(discovery["records"]), "checkpoint": {
                "page": page_number, "extracted": len(discovery["records"]), "note": "verified server pipeline handoff"}},
            {"type": "company_search", "count": company_count},
            {"type": "company_detail", "count": company_count},
            {"type": "contact_page", "count": company_count},
            {"type": "raw_contact_row", "count": len(enrichment["records"])},
        ]
        qualified_companies = sorted({
            str(record.get("company") or "").strip()
            for record in enrichment.get("records", [])
            if str(record.get("email") or "").strip()
        })
        qualified_remaining = max(
            int(task.get("budgets", {}).get("validEmailCompaniesDaily", 100) or 100)
            - int(task.get("counters", {}).get("qualifiedCompanies", 0) or 0),
            0,
        )
        qualified_companies = qualified_companies[:qualified_remaining]
        actions.extend(
            {"type": "qualified_company", "count": 1,
             "idempotencyKey": f"{action_base}:qualified-company:{hashlib.sha256(company.encode('utf-8')).hexdigest()[:16]}"}
            for company in qualified_companies
        )
        for action in actions:
            action["signal"] = "none"
            action.setdefault("idempotencyKey", (f"{plan['planId']}:{identity}:page:{page_number}:buyers"
                                                  if action["type"] == "buyer_entry" else f"{action_base}:{action['type']}"))
            remote.api("POST", f"/api/ops/tasks/{task['id']}/actions", action)

        remote.upload(discovery_path, discovery_reference)
        remote.upload(enrichment_path, enrichment_reference)
        job = find_or_create_page_job(remote, task["id"], page_token)

        if job.get("currentStage") == "discovery" and job.get("status") == "waiting_input":
            remote.api("POST", f"/api/pipeline/jobs/{job['id']}/resume", {"inputReference": discovery_reference})
            remote.run_worker()
            job = get_job(remote, job["id"])
        if job.get("currentStage") == "contact_enrichment" and job.get("status") == "waiting_input":
            remote.api("POST", f"/api/pipeline/jobs/{job['id']}/resume", {"inputReference": enrichment_reference})
            remote.run_worker()
            job = get_job(remote, job["id"])
        if job.get("currentStage") == "drafting" and job.get("status") == "waiting_input":
            remote.api("POST", f"/api/pipeline/jobs/{job['id']}/resume", {"inputReference": enrichment_reference})
            remote.run_worker()
            job = get_job(remote, job["id"])

        delivered = completed_handoff(job)
        at_review = job.get("currentStage") == "approval" and job.get("status") in {"waiting_input", "batch_review"}
        if not at_review and not delivered:
            raise RuntimeError(f"服务器流水线未停在审核门：{job.get('currentStage')}/{job.get('status')}")
        drafting = next((artifact for artifact in reversed(job.get("artifacts", [])) if artifact.get("stage") == "drafting"), {})
        result = {
            "ok": True,
            "planId": plan["planId"],
            "hsCode": hs_code,
            "pageNumber": page_number,
            "jobId": job["id"],
            "stage": job["currentStage"],
            "status": job["status"],
            "draftCounts": drafting.get("counts", {}),
            "sendingEnabled": bool(health.get("sendingEnabled")),
            "delivery": job.get("delivery") if delivered else None,
        }
        if delivered:
            result["sendSimulation"] = {
                "simulation": False,
                "mode": "managed_auto",
                "smtp": True,
                "accepted": int(job.get("delivery", {}).get("accepted", 0) or 0),
                "note": "托管自动发送已在交接期间完成；按已发送状态幂等返回",
            }
        elif args.simulate_send and job.get("status") == "waiting_input":
            result["sendSimulation"] = remote.api("POST", f"/api/pipeline/jobs/{job['id']}/simulate-send", {
                "confirm": f"SIMULATE SEND PIPELINE {job['id']}",
                "simulation": True,
            })
        elif args.simulate_send:
            result["sendSimulation"] = {
                "simulation": True,
                "mode": "central_batch",
                "smtp": False,
                "outboxCreated": 0,
                "wouldSend": int(drafting.get("counts", {}).get("draftedContacts", 0) or 0),
                "note": "托管草稿已进入集中批次审核；本次交接预演不调用发送接口",
            }
        print(json.dumps(result, ensure_ascii=False))
    finally:
        remote.close()


if __name__ == "__main__":
    self_test() if sys.argv[1:] == ["--self-test"] else main()
