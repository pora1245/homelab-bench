#!/usr/bin/env python3
"""Isolated agent/API auth contracts. Only synthetic keys and localhost fixtures."""
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target/debug/llm-bench"
TOKEN = "synthetic-agent-token-01234567890123456789"
CHECKS = []

def check(value, label):
    assert value, label
    CHECKS.append(label)

def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def request(url, body=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: data = json.loads(raw)
        except ValueError: data = {}
        return e.code, data

def wait_for(url, accepted):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if request(url)[0] in accepted: return
        except OSError: pass
        time.sleep(.05)
    raise AssertionError("isolated fixture did not start")

class Collector(http.server.BaseHTTPRequestHandler):
    seen = []
    sink_hits = 0
    sink_url = ""
    def log_message(self, *args): pass
    def do_GET(self):
        Collector.seen.append((self.path, self.headers.get("Authorization")))
        if self.path == "/redirect":
            self.send_response(302); self.send_header("Location", self.sink_url); self.end_headers(); return
        if self.path == "/sink": Collector.sink_hits += 1
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_response(401); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(),
            "cpu_model": "SYNTHETIC-REMOTE-CPU", "cpu_pct": 7, "gpus": []}).encode())

def main():
    env = {k:v for k,v in os.environ.items() if not k.startswith("BENCH_")}
    with tempfile.TemporaryDirectory(prefix="bench-agent-auth-") as tmp:
        tmp = Path(tmp)
        token_file = tmp / "agent.token"
        token_file.write_text(TOKEN + "\n"); token_file.chmod(0o600)
        rejected = subprocess.run([str(BINARY), "agent"], cwd=ROOT,
            env=dict(env, BENCH_AGENT_BIND="0.0.0.0:0"), capture_output=True, timeout=8)
        check(rejected.returncode != 0, "external bind without token fails before listen")
        rejected = subprocess.run([str(BINARY), "agent"], cwd=ROOT,
            env=dict(env, BENCH_AGENT_BIND="127.0.0.1:0", BENCH_AGENT_TOKEN=TOKEN, BENCH_AGENT_TOKEN_FILE=str(token_file)), capture_output=True, timeout=8)
        check(rejected.returncode != 0, "ambiguous env and file credentials fail closed")
        agent_port = port(); agent_url = f"http://127.0.0.1:{agent_port}"
        agent_log = tmp / "agent.log"
        with agent_log.open("w") as log:
            agent = subprocess.Popen([str(BINARY), "agent"], cwd=ROOT,
                env=dict(env, BENCH_AGENT_BIND=f"127.0.0.1:{agent_port}", BENCH_AGENT_TOKEN_FILE=str(token_file)), stdout=log, stderr=log)
            try:
                wait_for(agent_url + "/health", {401})
                for route in ["health", "metrics"]:
                    check(request(agent_url + "/" + route)[0] == 401, route + " rejects missing token")
                    check(request(agent_url + "/" + route, token="wrong")[0] == 401, route + " rejects wrong token")
                    check(request(agent_url + "/" + route, token=TOKEN)[0] == 200, route + " accepts token file credential")
                check(request(agent_url + "/health", token=TOKEN)[1].get("read_only") is True, "health identifies read-only collector")
                check(request(agent_url + "/metrics", {}, TOKEN)[0] == 405, "metrics has no write method")
                check(request(agent_url + "/exec", {}, TOKEN)[0] == 404, "collector has no command API")
            finally:
                agent.terminate(); agent.wait(timeout=10)
        check(TOKEN not in agent_log.read_text(), "agent logs never print token")

        fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Collector)
        sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Collector)
        Collector.sink_url = f"http://127.0.0.1:{sink.server_port}/sink"
        for server in [fixture, sink]: threading.Thread(target=server.serve_forever, daemon=True).start()
        data = tmp / "app-data"; app_port = port(); base = f"http://127.0.0.1:{app_port}/api/"
        def api(path, body=None):
            status, value = request(base + path, body)
            assert status == 200, (path, status, value)
            return value
        with (tmp / "app.log").open("w") as log:
            app = subprocess.Popen([str(BINARY)], cwd=ROOT, env=dict(env, BENCH_PORT=str(app_port), BENCH_DATA_DIR=str(data)), stdout=log, stderr=log)
            try:
                wait_for(base + "health", {200})
                d = api("devices", {"name": "synthetic remote", "mode": "http", "url": f"http://127.0.0.1:{fixture.server_port}/metrics", "api_key": TOKEN})
                check(d["has_key"] is True and TOKEN not in json.dumps(d), "device response has key-presence only")
                check(TOKEN not in json.dumps(api("devices")), "device listing excludes token")
                keys = json.loads((data / "credentials.json").read_text())
                check(keys.get("device:" + d["id"]) == TOKEN, "device credential stored in private namespace")
                if os.name == "posix": check((data / "credentials.json").stat().st_mode & 0o077 == 0, "credentials owner-only mode")
                v = api(f"devices/{d['id']}/sample")
                check(v["status"] == "connected" and v["data"]["cpu_model"] == "SYNTHETIC-REMOTE-CPU", "sampling uses authenticated selected collector")
                check(Collector.seen[-1][1] == "Bearer " + TOKEN, "Bearer credential reaches only selected endpoint")
                check(TOKEN not in json.dumps(v), "sample response excludes credential")
                d = api("devices", dict(d, api_key="wrong-token-000000000000000000000000"))
                v = api(f"devices/{d['id']}/sample")
                check(v["status"] == "unavailable" and "data" not in v, "remote auth failure cannot become local telemetry")
                d = api("devices", dict(d, url=f"http://127.0.0.1:{fixture.server_port}/redirect"))
                check(d["has_key"] is False, "changing destination clears old credential")
                d = api("devices", dict(d, api_key=TOKEN))
                v = api(f"devices/{d['id']}/sample")
                check(v["status"] == "unavailable" and Collector.sink_hits == 0, "redirect never forwards collector credentials")
                api(f"devices/{d['id']}/delete", {})
                check("device:" + d["id"] not in json.loads((data / "credentials.json").read_text()), "deleting device removes its credential")
            finally:
                app.terminate(); app.wait(timeout=10)
                fixture.shutdown(); sink.shutdown()
        check(TOKEN not in (tmp / "app.log").read_text(), "app logs exclude collector credential")
    result = {"passed": len(CHECKS), "checks": CHECKS, "scope": "isolated localhost fixtures and synthetic credentials; no model API or production connection"}
    dest = ROOT / "review/native-sandbox-2026-11-06/agent-auth-result.json"
    dest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__": main()
