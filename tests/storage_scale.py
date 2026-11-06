#!/usr/bin/env python3
"""Synthetic storage/API scale check. Never starts a model inference request."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}/api/"

    def api(path, body=None):
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        req = urllib.request.Request(base + path, data=payload, headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
        return json.loads(raw), {"elapsed_ms": round((time.perf_counter() - started) * 1000, 2), "wire_bytes": len(raw)}

    with tempfile.TemporaryDirectory(prefix="llm-bench-scale-") as data:
        env = dict(os.environ, BENCH_DATA_DIR=data, BENCH_PORT=str(port))
        with open(Path(data) / "server.log", "w") as log:
            def boot():
                started = time.perf_counter()
                process = subprocess.Popen([str(ROOT / "target/debug/llm-bench")], cwd=ROOT, env=env, stdout=log, stderr=log)
                for _ in range(1200):
                    try:
                        api("health")
                        return process, round((time.perf_counter() - started) * 1000, 2)
                    except OSError:
                        time.sleep(.05)
                process.terminate()
                process.wait(10)
                raise AssertionError("app startup failed")

            process, boot_ms = boot()
            try:
                metrics = {"ttft_ms": 12, "ttft_source": "client_stream", "ttft_reason": "", "wall_ms": 100,
                           "input_tokens": 128, "output_tokens": 512, "decode_tps": 50, "prefill_tps": 300,
                           "decode_source": "server", "prefill_source": "server"}
                attempt = {"started_at": "2026-11-06T00:00:00Z", "ended_at": "2026-11-06T00:00:01Z",
                           "output": "a" * 2048, "reasoning": "", "finish_reason": "stop", "error": None,
                           "metrics": metrics, "score": {"value": 1, "state": "passed", "detail": "fixture", "scorer_version": "fixture", "extra": {}},
                           "raw": [{"delta": "a" * 2048}]}
                items = [{"task": {"id": f"item-{i}", "subject": "fixture", "prompt": "p" * 512,
                                   "answer": "a" * 2048, "scorer": "exact", "max_tokens": 4096, "meta": {}},
                          "status": "done", "attempts": [attempt]} for i in range(10000)]
                run = {"id": "supplied", "created_at": "2026-11-06T00:00:00Z",
                       "config": {"name": "10k storage fixture", "base_url": "http://127.0.0.1:1", "model": "never-called",
                                  "pack_id": "fixture", "profile": "full", "temperature": 0, "max_tokens": 4096, "concurrency": 1, "timeout_s": 5},
                       "status": "completed", "suite_hash": "fixture", "protocol_version": "fixture", "pack_version": "fixture",
                       "provenance": "fixture", "items": items, "telemetry": [], "active_ms": 100000, "error": None}
                upload_bytes = len(json.dumps(run, separators=(",", ":")).encode())
                response, insert = api("import", run)
                rid = response["id"]
                reads = []
                for _ in range(3):
                    fetched, timing = api("runs/" + rid)
                    reads.append(timing)
                assert len(fetched["items"]) == 10000 and fetched["items"][-1]["task"]["id"] == "item-9999"
                compact, compact_timing = api("runs/" + rid + "?view=compact")
                assert compact["summary"] == fetched["summary"]
                assert all(not item["task"]["prompt"] and not item["attempts"][0]["output"] for item in compact["items"])
                detail, detail_timing = api(f"runs/{rid}/items/9999")
                assert detail["task"]["id"] == "item-9999" and detail["attempts"][0]["output"] == "a" * 2048
                _, listing = api("runs")
                with sqlite3.connect(Path(data) / "app.sqlite3") as db:
                    started = time.perf_counter()
                    rows = db.execute("SELECT body FROM run_items WHERE run_id=? ORDER BY position", (rid,)).fetchall()
                    sql_ms = round((time.perf_counter() - started) * 1000, 2)
                    header_bytes = db.execute("SELECT length(body) FROM runs WHERE id=?", (rid,)).fetchone()[0]
                    assert len(rows) == 10000
                process.terminate()
                process.wait(10)
                process, restart_ms = boot()
                restored, restored_timing = api("runs/" + rid)
                assert len(restored["items"]) == 10000 and restored["items"][-1]["attempts"][0]["output"] == "a" * 2048
                result = {"scope": "local synthetic 10000 completed records; no model/API inference; debug binary",
                          "items": 10000, "upload_bytes": upload_bytes, "empty_boot_ms": boot_ms, "import": insert,
                          "db_header_bytes": header_bytes, "sql_select_rows_ms": sql_ms, "run_get": reads,
                          "compact_get": compact_timing, "item_get": detail_timing, "run_list": listing,
                          "restart_load_ms": restart_ms, "get_after_restart": restored_timing,
                          "verified": "10000 rows and last output preserved after restart; compact summary and selected item match full API"}
                (ROOT / "evidence/storage-10k-review.json").write_text(json.dumps(result, indent=2))
                print(json.dumps(result, indent=2))
            finally:
                process.terminate()
                process.wait(10)


if __name__ == "__main__":
    main()
