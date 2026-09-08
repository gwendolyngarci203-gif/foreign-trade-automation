from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".codex_work" / "python_deps"))


def configured_qualified_company_target():
    try:
        plan = json.loads((ROOT / "plans" / "managed-hscode-plan.json").read_text(encoding="utf-8"))
        return max(int(plan.get("dailyBudgets", {}).get("validEmailCompanies", 100) or 100), 1)
    except (OSError, ValueError, TypeError):
        return 100


def selected_company_count(batch):
    return len({str(item.get("company") or "").strip().casefold() for item in batch.get("selected", []) if str(item.get("company") or "").strip()})


def load_handoff():
    spec = importlib.util.spec_from_file_location("handoff", ROOT / "tools" / "handoff-managed-pipeline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(health, batch, outbox, mode, qualified_company_target=100):
    circuit = health.get("delivery", {}).get("circuit", {})
    fleet = health.get("delivery", {}).get("senderFleet", {})
    counts = outbox.get("counts", {})
    selected = batch.get("selected", [])
    blockers = []
    if not health.get("ok") or not health.get("sourceLoaded"): blockers.append("production_health")
    if mode == "sending":
        if not health.get("ai", {}).get("configured") or not health.get("ai", {}).get("reachable"): blockers.append("ai_unreachable")
        if circuit.get("open"): blockers.append("delivery_circuit_open")
        if health.get("delivery", {}).get("allowUnverified"): blockers.append("allow_unverified_enabled")
        if counts.get("failed", 0) or counts.get("uncertain", 0): blockers.append("outbox_failure_or_uncertain")
        if fleet.get("configured", 0) == 0 or fleet.get("remaining", 0) == 0: blockers.append("sender_fleet_exhausted")
    capacity = health.get("delivery", {}).get("capacity", {})
    configured_limit = int(capacity.get("globalLimit", batch.get("limit", 0)) or 0)
    send_target = configured_limit if mode == "collection" else min(
        int(capacity.get("availableCapacity", configured_limit) or 0),
        int(batch.get("remaining", configured_limit) or 0),
        int(batch.get("senderCapacity", {}).get("remaining", 0) or 0),
    )
    inventory = batch.get("inventory") or {}
    qualified_company_count = int(inventory.get("totalCompanies", 0) or batch.get("selectedCompanyCount", 0) or selected_company_count(batch))
    capacity_ready = qualified_company_count >= qualified_company_target if mode == "collection" else len(selected) >= send_target
    capacity_gap = max((qualified_company_target - qualified_company_count) if mode == "collection" else (send_target - len(selected)), 0)
    if mode == "sending" and not capacity_ready:
        blockers.append("qualified_company_capacity_below_send_target")
    action = "hold" if mode == "collection" and capacity_ready else "replenish" if mode == "collection" else "send"
    return {"ok": not blockers, "mode": mode, "action": action, "blockers": blockers, "health": {"sendingEnabled": health.get("sendingEnabled"), "daily": health.get("delivery", {}).get("daily"), "senderFleet": fleet}, "batch": {"selected": len(selected), "selectedCompanyCount": qualified_company_count, "qualifiedCompanyTarget": qualified_company_target, "sendTarget": send_target, "capacityGap": capacity_gap, "capacityReady": capacity_ready, "senderCapacity": batch.get("senderCapacity"), "sendsRequireApproval": batch.get("sendsRequireApproval")}, "outboxCounts": counts}


def self_test():
    health = {"ok": True, "sourceLoaded": True, "ai": {"configured": False, "reachable": False}, "delivery": {"allowUnverified": False, "circuit": {"open": True}, "capacity": {"globalLimit": 500, "availableCapacity": 500}, "senderFleet": {"configured": 0, "remaining": 500}}}
    batch = {"remaining": 500, "senderCapacity": {"remaining": 500}, "selected": [{}, {}, {}], "sendsRequireApproval": True}
    outbox = {"counts": {"failed": 0, "uncertain": 0}}
    collection = evaluate(health, batch, outbox, "collection")
    assert collection["ok"] and collection["action"] == "replenish"
    full_batch = {**batch, "selected": [{"company": f"company-{index // 2}"} for index in range(200)]}
    assert evaluate(health, full_batch, outbox, "collection")["action"] == "hold"
    sending = evaluate(health, batch, outbox, "sending")
    assert not sending["ok"] and sending["batch"]["capacityGap"] == 497
    print(json.dumps({"ok": True, "check": "collection_continues_while_sending_capacity_is_blocked"}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("collection", "sending"), default="sending")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    remote = load_handoff().Remote()
    try:
        health = remote.api("GET", "/api/health")
        batch = remote.api("GET", "/api/pipeline/daily-batch?limit=1000&reserve=1&central=1" if args.mode == "collection" else "/api/pipeline/daily-batch?limit=1000&central=1")
        outbox = remote.api("GET", "/api/outbox")
    finally:
        remote.close()
    result = evaluate(health, batch, outbox, args.mode, configured_qualified_company_target())
    print(json.dumps(result, ensure_ascii=False))
    if result["blockers"]: raise SystemExit(2)
    if result["action"] == "hold": raise SystemExit(3)


if __name__ == "__main__":
    main()
