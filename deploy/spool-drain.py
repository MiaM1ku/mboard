#!/usr/bin/env python3
"""Drain the mboard-node traffic spool against the panel.

Posted batches are immutable and idempotent on the panel side (batch_id ledger),
so replaying a batch that was already accepted returns 200 without double counting.

On success the spool file is removed, exactly like Spool.Flush does.
On failure the file is left in place and the status/body is appended to the
report so a poisoned batch can be identified and quarantined.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import ssl
import sys
import threading
import urllib.error
import urllib.request

PANEL = "https://panel.008288.xyz"
TOKEN = ""
SPOOL = "/opt/mboard-node/data/spool"
QUARANTINE = "/opt/mboard-node/data/spool-quarantine"


def post(path: str, token: str, panel: str):
    with open(path, "rb") as fh:
        raw = fh.read()
    req = urllib.request.Request(
        panel + "/api/node/v1/traffic",
        data=raw,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read(2000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(2000).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - transport errors are reported verbatim
        return 0, repr(exc)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--spool", default=SPOOL)
    ap.add_argument("--panel", default=PANEL)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--quarantine", default=QUARANTINE)
    ap.add_argument("--report", default="/root/mboard-rescue/drain-report.json")
    ap.add_argument("--dry-run", action="store_true", help="report only, delete nothing")
    args = ap.parse_args()

    files = sorted(
        os.path.join(args.spool, name)
        for name in os.listdir(args.spool)
        if name.endswith(".json")
    )
    work: "queue.Queue[str]" = queue.Queue()
    for path in files:
        work.put(path)

    failures: list[dict] = []
    ok = 0
    removed = 0
    lock = threading.Lock()

    def worker() -> None:
        nonlocal ok, removed
        while True:
            try:
                path = work.get_nowait()
            except queue.Empty:
                return
            status, body = post(path, args.token, args.panel.rstrip("/"))
            with lock:
                if 200 <= status < 300:
                    ok += 1
                    if not args.dry_run:
                        try:
                            os.remove(path)
                            removed += 1
                        except FileNotFoundError:
                            removed += 1
                else:
                    failures.append(
                        {
                            "file": os.path.basename(path),
                            "status": status,
                            "body": body.strip(),
                        }
                    )
            work.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    summary = {
        "total": len(files),
        "accepted": ok,
        "removed": removed,
        "failed": len(failures),
        "dry_run": args.dry_run,
        "failures": failures[:200],
    }
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k != "failures"}, ensure_ascii=False))
    for item in failures[:20]:
        print("FAIL", item["file"], item["status"], item["body"][:200])
    if failures and not args.dry_run:
        os.makedirs(args.quarantine, exist_ok=True)
        for item in failures:
            src = os.path.join(args.spool, item["file"])
            if os.path.exists(src):
                os.replace(src, os.path.join(args.quarantine, item["file"]))
        print("quarantined", len(failures), "batches ->", args.quarantine)
    return 0 if not failures else 2


if __name__ == "__main__":
    sys.exit(main())
