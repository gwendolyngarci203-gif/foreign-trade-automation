from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".codex_work" / "active-managed-plan.json"
BASE_PLAN = ROOT / "plans" / "managed-hscode-plan.json"
sys.path.insert(0, str(ROOT / ".codex_work" / "python_deps"))


def load_handoff():
    spec = importlib.util.spec_from_file_location("handoff", ROOT / "tools" / "handoff-managed-pipeline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate(plan: dict) -> None:
    if plan.get("schemaVersion") != 1 or plan.get("mode") != "managed":
        raise RuntimeError("服务器托管计划格式无效")
    hs_codes = plan.get("hsCodes")
    if not isinstance(hs_codes, list) or len(hs_codes) != 1 or not str(hs_codes[0].get("hsCode", "")).isdigit():
        raise RuntimeError("服务器托管计划必须包含一个有效 HSCode")


def merge_budget_floors(plan: dict, baseline: dict) -> dict:
    remote = plan.setdefault("dailyBudgets", {})
    local = baseline.get("dailyBudgets", {})
    for key in ("buyerEntries", "companyDetails", "validEmailCompanies", "contactPages", "emailSends"):
        remote[key] = int(local.get(key, remote.get(key, 0)) or 0)
    remote["globalEmailHardCap"] = min(1000, int(remote.get("globalEmailHardCap", 500) or 500), int(local.get("globalEmailHardCap", 500) or 500))
    return plan


def task_budget_payload(plan: dict) -> dict:
    budgets = plan["dailyBudgets"]
    hs_code = str(plan["hsCodes"][0]["hsCode"])
    return {
        "budgets": {
            "buyerEntriesDaily": budgets["buyerEntries"],
            "companyDetailsDaily": budgets["companyDetails"],
            "validEmailCompaniesDaily": budgets["validEmailCompanies"],
            "contactPagesDaily": budgets["contactPages"],
            "emailSendsDaily": budgets["emailSends"],
        },
        "confirm": f"AUTHORIZE MANAGED {hs_code}",
    }


def self_test() -> None:
    merged = merge_budget_floors({"dailyBudgets": {"companyDetails": 240}, "hsCodes": [{"startPage": 12}]}, {"dailyBudgets": {"companyDetails": 100, "emailSends": 200}})
    assert merged["dailyBudgets"]["companyDetails"] == 100
    assert merged["dailyBudgets"]["emailSends"] == 200
    assert merged["hsCodes"][0]["startPage"] == 12
    payload = task_budget_payload({"dailyBudgets": {"buyerEntries": 400, "companyDetails": 300, "validEmailCompanies": 100, "contactPages": 300, "emailSends": 200}, "hsCodes": [{"hsCode": "4903000"}]})
    assert payload["budgets"]["buyerEntriesDaily"] == 400
    assert payload["confirm"] == "AUTHORIZE MANAGED 4903000"
    print(json.dumps({"ok": True, "check": "remote_checkpoint_with_local_budget_floors"}))


def main() -> None:
    remote = load_handoff().Remote()
    try:
        plan = remote.api("GET", "/api/managed-plan")
        plan.setdefault("schemaVersion", 1)
        merge_budget_floors(plan, json.loads(BASE_PLAN.read_text(encoding="utf-8")))
        validate(plan)
        if plan.get("sourceTaskId"):
            remote.api("PUT", f"/api/ops/tasks/{plan['sourceTaskId']}", task_budget_payload(plan))
    finally:
        remote.close()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, OUTPUT)
    print(json.dumps({"ok": True, "plan": str(OUTPUT), "planId": plan["planId"], "hsCode": plan["hsCodes"][0]["hsCode"]}, ensure_ascii=False))


if __name__ == "__main__":
    self_test() if sys.argv[1:] == ["--self-test"] else main()
