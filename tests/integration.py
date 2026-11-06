#!/usr/bin/env python3
"""Local contract tests with deliberately synthetic responses; not model scores."""
import copy
from datetime import datetime, timedelta, timezone
import http.server
import json
import math
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
requests = []
request_auth = []
recover = False
delay_judge = False
checkpoint_release = threading.Event()
checks = []

def assert_ok(condition, label):
    assert condition, label
    checks.append(label)

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        request_auth.append({"path":self.path,"model":None,"authorization":self.headers.get("Authorization", "")})
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        measured = datetime.now(timezone.utc) - timedelta(seconds=60 if self.path.endswith("stale") else 0)
        value = {"data": [{"id": "contract-fixture"}]} if self.path.endswith("models") else {"timestamp":measured.isoformat(), "cpu_pct": 12, "ram_used_bytes": 100, "ram_total_bytes": 1000, "gpus": []}
        if self.path.endswith("no-time"): value.pop("timestamp", None)
        self.wfile.write(json.dumps(value).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        request_auth.append({"path":self.path,"model":body["model"],"authorization":self.headers.get("Authorization", "")})
        prompt = body["messages"][0]["content"]
        if prompt == "http-error" and not recover:
            self.send_response(503); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type", "text/plain" if prompt == "live-ttft" else "text/event-stream"); self.end_headers()
        if prompt == "slow": time.sleep(0.9)
        response = {"numeric": "계산 결과 #### 42", "choice": "The answer is (B).", "json": '{"ok":true}', "unicode": "한글🙂 확인", "ifeval": "hello", "judge-task": "candidate answer"}.get(prompt, "ok")
        if prompt.startswith("Evaluate the candidate"):
            response = '{"score":1,"reason":"rubric matched"}'
            if delay_judge: time.sleep(3)
        if body["model"] == "wrong-fixture" and prompt == "numeric": response = "#### 41"
        try:
            for chunk in [response[:3], response[3:]]:
                frame = ("data: " + json.dumps({"choices": [{"delta": {"content": chunk}}]}, ensure_ascii=False) + "\r\n\r\n").encode()
                # Deliberately split UTF-8 sequences across transport writes.
                for b in frame:
                    self.wfile.write(bytes([b]))
                self.wfile.flush(); time.sleep(0.10)
            if prompt == "broken" and not recover: return
            if prompt == "live-ttft": time.sleep(3)
            if prompt == "checkpoint": checkpoint_release.wait(20)
            end = {"choices": [{"delta": {}, "finish_reason": "length" if prompt == "truncated" else "stop"}], "usage": {"prompt_tokens": 30, "completion_tokens": 10}, "timings": {"predicted_per_second": 50, "prompt_per_second": 300}}
            self.wfile.write(("data: " + json.dumps(end) + "\n\ndata: [DONE]\n\n").encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0)); return sock.getsockname()[1]

def main():
    global recover, delay_judge
    fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    port = free_port(); base = f"http://127.0.0.1:{port}"
    target = f"http://127.0.0.1:{fixture.server_port}"
    env = dict(os.environ, BENCH_PORT=str(port))
    def api(path, body=None, origin=None):
        headers={"Content-Type": "application/json"}
        if origin: headers["Origin"] = origin
        req=urllib.request.Request(base+"/api/"+path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    def wait(id, states=("completed",), timeout=30):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            r=api("runs/"+id)
            if r["status"] in states: return r
            time.sleep(.05)
        raise AssertionError(("timed out", r["status"]))
    def wait_live_ttft(id, timeout=5):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            r=api("runs/"+id)
            a=r["items"][0]["attempts"]
            if a and a[-1]["metrics"]["ttft_ms"] is not None:
                assert_ok(r["status"]=="running" and a[-1]["ended_at"] is None,"live TTFT visible before response finishes")
                return a[-1]["metrics"]["ttft_ms"]
            time.sleep(.02)
        raise AssertionError("live TTFT not published")
    with tempfile.TemporaryDirectory(prefix="llm-bench-test-") as data:
        env["BENCH_DATA_DIR"]=data
        log=open(ROOT/"evidence/integration-server.log","w")
        def boot():
            p=subprocess.Popen([str(ROOT/"target/debug/llm-bench")], cwd=ROOT, env=env, stdout=log, stderr=log)
            for _ in range(100):
                try:
                    if api("health")["ok"]: return p
                except (OSError, ValueError): pass
                time.sleep(.05)
            raise AssertionError("app startup failed")
        process=boot()
        try:
            setup=api("setup")
            assert_ok(setup["preferences"]["model_location"] is None and not setup["preferences"]["completed"],"first launch does not infer model location")
            assert_ok(setup["platform"] in ("macos","windows","linux"),"setup identifies app host OS, not browser OS")
            preference=dict(setup["preferences"],model_location="remote",code_grading=False,completed=True)
            before_requests=len(requests)
            api("setup",preference)
            assert_ok(api("setup")["preferences"]["model_location"]=="remote" and not api("setup")["preferences"]["code_grading"],"setup choices persist separately from readiness")
            assert_ok(len(requests)==before_requests and api("runs")==[] and api("connections")==[],"saving setup neither starts a benchmark nor creates model associations")
            for invalid in (None,"localhost"):
                try:api("setup",dict(preference,model_location=invalid));raise AssertionError("invalid completed setup accepted")
                except urllib.error.HTTPError as exc:assert exc.code==400
            assert_ok(api("setup")["preferences"]["model_location"]=="remote","invalid setup cannot overwrite existing preferences")
            process.terminate();process.wait();process=boot()
            assert_ok(api("setup")["preferences"]["completed"],"completed setup survives app restart")
            pack={"id":"fixture-v1","name":"검증 전용 가상 응답","version":"test.1","sources":{"type":"synthetic"},"tasks":[]}
            for name, scorer, answer in [("numeric","numeric","42"),("choice","choice","B"),("json","json",{"ok":True}),("unicode","exact","한글🙂 확인"),("broken","exact","ok"),("http-error","exact","ok"),("truncated","exact","ok"),("ifeval","ifeval","constraints"),("judge-task","judge","CANARY-REFERENCE")]:
                meta={"secret":"CANARY-REFERENCE"}
                if scorer=="ifeval":meta={"key":1,"instruction_id_list":["keywords:existence"],"kwargs":[{"keywords":["hello"]}]}
                if scorer=="judge":meta={"rubric":"Match the reference."}
                pack["tasks"].append({"id":"custom:ifeval" if name=="ifeval" else name,"subject":"계약 시험","prompt":name,"answer":answer,"scorer":scorer,"max_tokens":64,"meta":meta})
            api("packs",pack)
            # User packs cannot masquerade as bundled/public score components.
            custom=copy.deepcopy(pack);custom.update(id="custom:fixture",name="User fixture")
            custom["tasks"]=[dict(pack["tasks"][0],id="custom:question")]
            api("packs",custom)
            assert_ok(any(p["id"]==custom["id"] for p in api("packs")),"ordinary custom-prefixed pack is accepted")
            original_packs=api("packs")
            prefixes=["gsm8k", "math500", "math-500", "mmlu-pro", "ifeval", "HumanEval", "mbpp", "livecodebench", "lcb:", "experience:", "api-experience", "ko-core", "korean-core", "collection-full", "public-core", "bbh"]
            for slot in ("pack", "task"):
                for prefix in prefixes:
                    candidate=copy.deepcopy(custom);candidate["id"]="custom:rejected-candidate"
                    if slot=="pack":candidate["id"]=prefix+"-not-installed-fixture"
                    else:candidate["tasks"][0]["id"]=prefix+"-not-installed-question"
                    try:
                        api("packs",candidate)
                        raise AssertionError("reserved identity was accepted")
                    except urllib.error.HTTPError as exc:
                        message=exc.read().decode()
                        assert exc.code==400 and "custom:" in message,(slot,prefix,exc.code,message)
                assert_ok(True,f"reserved official {slot} IDs rejected even when not installed (case-insensitive)")
            assert_ok(api("packs")==original_packs,"rejected reserved identities leave original and custom packs unchanged")
            c={"name":"contract run","base_url":target+"/v1","model":"contract-fixture","pack_id":"fixture-v1","profile":"full","subjects":[],"temperature":0,"max_tokens":64,"concurrency":2,"timeout_s":5,"telemetry_url":target+"/metrics","judge":{"base_url":target,"model":"judge-fixture","max_tokens":64}}
            default_values={"temperature":0,"max_tokens":64,"concurrency":1,"timeout_s":5}
            saved=api("connections",{"name":"Saved target","kind":"target","base_url":target,"model":"contract-fixture","defaults":default_values,"api_key":"PERSIST-TARGET"})
            judge=api("connections",{"name":"Saved judge","kind":"judge","base_url":target,"model":"judge-fixture","defaults":default_values,"api_key":"PERSIST-JUDGE"})
            second=api("connections",{"name":"Alternate target","kind":"target","base_url":target,"model":"wrong-fixture","is_default":True,"api_key":"DELETE-THIS-KEY"})
            profiles=api("connections")
            assert_ok(sum(p["is_default"] for p in profiles if p["kind"]=="target")==1 and next(p for p in profiles if p["id"]==second["id"])["is_default"],"one default per connection role")
            api(f"connections/{saved['id']}/default",{})
            api(f"connections/{second['id']}/delete",{})
            assert_ok(all(p["id"]!=second["id"] for p in api("connections")),"connection delete removes profile")
            edited=dict(saved,name="Saved target renamed");edited.pop("has_key",None)
            saved=api("connections",edited)
            assert_ok(saved["has_key"] and saved["name"].endswith("renamed"),"editing profile without key preserves saved credential")
            assert_ok(api(f"connections/{saved['id']}/check",{})["ok"] and request_auth[-1]["authorization"]=="Bearer PERSIST-TARGET","saved connection check uses stored key")
            assert_ok("PERSIST-" not in json.dumps(api("connections")),"connection API never returns secret values")
            credentials=Path(data,"credentials.json")
            assert_ok(credentials.stat().st_mode & 0o777 == 0o600 and "DELETE-THIS-KEY" not in credentials.read_text(),"credential file is private and deleted credentials are removed")
            local=next(d for d in api("devices") if d["mode"]=="local")
            sample=api(f"devices/{local['id']}/sample")
            assert_ok(sample["ok"] and sample["status"]=="connected" and sample["data"]["ram_total_bytes"]>0,"local device sample includes fresh CPU and RAM data")
            device=api("devices",{"name":"Fixture sensors","mode":"http","url":target+"/metrics","is_default":True})
            assert_ok(api(f"devices/{device['id']}/check",{})["status"]=="connected","HTTP device check accepts fresh timestamp")
            stale=api("devices",{"name":"Old sensors","mode":"http","url":target+"/metrics-stale"})
            sample=api(f"devices/{stale['id']}/sample")
            assert_ok(not sample["ok"] and sample["status"]=="stale" and sample["age_ms"]>=59000,"old sensor data is stale rather than connected")
            missing=api("devices",{"name":"Undated sensors","mode":"http","url":target+"/metrics-no-time"})
            assert_ok(api(f"devices/{missing['id']}/sample")["status"]=="stale","sensor data without timestamp is not live")
            api(f"devices/{stale['id']}/delete",{});api(f"devices/{missing['id']}/delete",{})
            api(f"devices/{local['id']}/default",{})
            assert_ok(sum(d["is_default"] for d in api("devices"))==1,"device default is unique")
            assert_ok(api("check",{"base_url":target})["models"][0]["id"]=="contract-fixture","model list connectivity")
            # Exact browser case: optional judge/device are null, and the name is blank.
            ui_pack=copy.deepcopy(pack);ui_pack["id"]="ui-start-fixture";ui_pack["tasks"]=ui_pack["tasks"][:1]
            api("packs",ui_pack)
            ui_config=dict(c,name="",pack_id=ui_pack["id"],judge=None,judge_connection_id=None,device_id=None,telemetry_url="")
            ui_id=api("runs",{"config":ui_config,"connection_id":saved["id"],"judge_connection_id":None,"device_id":None})["id"]
            ui_run=wait(ui_id)
            assert_ok(ui_run["status"]=="completed" and ui_run["summary"]["completed"]==1 and ui_run["config"]["name"].startswith("contract-fixture"),"browser new test accepts no judge/device and generates a default name")
            ui_again=api("runs",{"config":dict(ui_config,judge_connection_id="",device_id=""),"connection_id":saved["id"],"judge_connection_id":"","device_id":""})["id"]
            assert_ok(wait(ui_again)["summary"]["completed"]==1 and ui_again!=ui_id,"another new test starts after the previous test completes")
            rid=api("runs",{"config":c,"api_key":"SECRET-TARGET","judge_key":"SECRET-JUDGE"})["id"]
            early=api("runs/"+rid)
            assert_ok(all(i["task"]["answer"] is None for i in early["items"] if i["status"] not in ("done","error")),"answers hidden until response completion")
            r=wait(rid)
            assert_ok(r["summary"]["errors"]==2,"HTTP and incomplete stream remain errors")
            assert_ok(r["summary"]["truncated"]==1,"output limit visible")
            assert_ok(r["summary"]["score_errors"]==0,"official IFEval and judge bridge usable")
            assert_ok(r["summary"]["subjects"]["계약 시험"]["points"]==7,"deterministic and judge scores")
            assert_ok(r["items"][3]["attempts"][0]["output"]=="한글🙂 확인","fragmented UTF-8 streaming")
            assert_ok(r["summary"]["decode_tps"]["median"]==50 and r["summary"]["prefill_tps"]["median"]==300,"native timing fields retained")
            assert_ok(all("CANARY-REFERENCE" not in json.dumps(q) for q in requests if q["model"]!="judge-fixture"),"reference never sent to target model")
            assert_ok(any("CANARY-REFERENCE" in json.dumps(q) for q in requests if q["model"]=="judge-fixture"),"reference sent only to explicit judge API")
            assert_ok(all(q["temperature"]==0 for q in requests),"temperature passed through")
            raw=api("export/"+rid)
            assert_ok(raw["items"][0]["attempts"][0]["raw"] and "SECRET-" not in json.dumps(raw),"raw response retained without API keys")
            recover=True
            api("runs/"+rid+"/retry",{"api_key":"SECRET-TARGET"})
            r=wait(rid)
            assert_ok(r["summary"]["errors"]==0 and len(r["items"][4]["attempts"])==2 and len(r["items"][0]["attempts"])==1,"retry failed requests only")
            before=len(requests); api("runs/"+rid+"/rescore",{"judge_key":"SECRET-JUDGE"}); r=wait(rid)
            assert_ok(len(requests)==before+1,"rescore invokes judge only; target answers reused")
            c2=copy.deepcopy(c);c2["model"]="wrong-fixture";c2["name"]="comparison"
            rid2=api("runs",{"config":c2})["id"];wait(rid2)
            cmp=api(f"compare/{rid}/{rid2}")
            assert_ok(cmp["correct_to_wrong"]==["numeric"] and cmp["paired"]==9,"paired correct-to-wrong comparison")
            try:api("packs",pack,origin="https://untrusted.example")
            except urllib.error.HTTPError as e: assert_ok(e.code==403,"cross-origin mutation rejected")
            else:raise AssertionError("origin guard missing")
            quick=copy.deepcopy(pack);quick["id"]="quick-fixture";quick["sources"]["quick_ids"]=["numeric","unicode","judge-task"]
            api("packs",quick)
            saved_config=copy.deepcopy(c);saved_config.update(base_url="http://127.0.0.1:1",model="must-be-resolved",pack_id="quick-fixture",profile="quick",connection_id=saved["id"],judge_connection_id=judge["id"],device_id=device["id"])
            auth_start=len(request_auth)
            saved_id=api("runs",{"config":saved_config})["id"];saved_run=wait(saved_id)
            assert_ok([i["task"]["id"] for i in saved_run["items"]]==["numeric","unicode","judge-task"],"quick profile uses pack quick_ids rather than first N tasks")
            assert_ok(saved_run["config"]["model"]=="contract-fixture" and saved_run["config"]["device_name"]=="Fixture sensors" and saved_run["summary"]["errors"]==0,"run resolves saved target judge and device profiles")
            generated=[a for a in request_auth[auth_start:] if a["model"]]
            assert_ok(generated and all(a["authorization"]==("Bearer PERSIST-JUDGE" if a["model"]=="judge-fixture" else "Bearer PERSIST-TARGET") for a in generated),"target and judge each use their own persisted credential")
            live=copy.deepcopy(pack);live["id"]="live-ttft-fixture";live["tasks"]=[dict(pack["tasks"][3],id="live-ttft",prompt="live-ttft",answer="ok")]
            api("packs",live)
            live_config=copy.deepcopy(saved_config);live_config.update(pack_id=live["id"],profile="full")
            live_id=api("runs",{"config":live_config})["id"];measured_ttft=wait_live_ttft(live_id);live_run=wait(live_id)
            live_metrics=live_run["items"][0]["attempts"][0]["metrics"]
            assert_ok(live_metrics["ttft_ms"]==measured_ttft and live_metrics["ttft_source"]=="client_visible_stream","final TTFT matches live first-chunk measurement despite plain-text MIME")
            assert_ok(any(t.get("status")=="connected" and t.get("device_id")==device["id"] for t in live_run["telemetry"]),"running benchmark records selected device samples")
            slow=copy.deepcopy(pack);slow["id"]="slow-v1";slow["tasks"]=[dict(pack["tasks"][3],id=f"slow-{i}",prompt="slow",answer="ok") for i in range(8)]
            api("packs",slow); c3=copy.deepcopy(saved_config);c3.update(pack_id="slow-v1",profile="full",concurrency=1)
            rid3=api("runs",{"config":c3})["id"];time.sleep(.15);api("runs/"+rid3+"/pause",{});r=wait(rid3,("paused",))
            assert_ok(r["summary"]["completed"]==1,"pause drains current request and stops dispatch")
            api("runs/"+rid3+"/resume",{});time.sleep(.15)
            process.kill();process.wait();process=boot();r=api("runs/"+rid3)
            assert_ok(r["status"]=="interrupted" and r["summary"]["completed"]==1,"restart preserves completed item and marks unfinished attempt")
            auth_start=len(request_auth)
            api("runs/"+rid3+"/resume",{});time.sleep(.15);api("runs/"+rid3+"/cancel",{});r=wait(rid3,("cancelled",))
            assert_ok(all(i["status"]!="running" for i in r["items"]),"cancel ends in-flight tracking")
            generated=[a for a in request_auth[auth_start:] if a["model"]]
            assert_ok(generated and all(a["authorization"]=="Bearer PERSIST-TARGET" for a in generated),"restart and resume restore target credential without re-entry")
            auth_start=len(request_auth);api("runs/"+saved_id+"/rescore",{});wait(saved_id)
            generated=[a for a in request_auth[auth_start:] if a["model"]]
            assert_ok(len(generated)==1 and generated[0]["authorization"]=="Bearer PERSIST-JUDGE","restart and rescore restore judge credential without re-entry")
            assert_ok(any(p["id"]==saved["id"] and p["has_key"] and p["name"].endswith("renamed") for p in api("connections")),"connection profile and key presence survive restart")
            assert_ok(any(d["id"]==device["id"] for d in api("devices")),"device profiles survive restart")
            assert_ok("PERSIST-" not in json.dumps(api("export/"+saved_id)),"saved connection credentials are excluded from run export")
            imported=copy.deepcopy(api("export/"+saved_id))
            imported["config"].update(base_url="http://127.0.0.1:1",connection_id=saved["id"],judge_connection_id=judge["id"],device_id=device["id"],device=device)
            imported_id=api("import",imported)["id"];imported_run=api("runs/"+imported_id)
            assert_ok(all(not imported_run["config"][k] for k in ["connection_id","judge_connection_id","device_id"]) and imported_run["config"]["device"] is None,"imported records cannot inherit local credentials or device access")
            compact=api("runs/"+saved_id+"?view=compact")
            current_summary=api("runs/"+saved_id)["summary"]
            assert_ok(compact["summary"]==current_summary,"compact run API retains current result summary")
            assert_ok(all(i["task"]["prompt"]=="" and all(a["output"]=="" and a["raw"] is None for a in i["attempts"]) for i in compact["items"]),"compact run API omits full prompts and outputs")
            grading_pack=copy.deepcopy(pack);grading_pack["id"]="grading-restart-fixture";grading_pack["tasks"]=[pack["tasks"][-1]]
            api("packs",grading_pack)
            grading_config=copy.deepcopy(saved_config);grading_config.update(pack_id=grading_pack["id"],profile="full",concurrency=1)
            delay_judge=True
            grading_id=api("runs",{"config":grading_config})["id"]
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                grading_run=api("runs/"+grading_id)
                if grading_run["items"][0]["status"]=="grading":break
                time.sleep(.02)
            else:raise AssertionError("grading state not reached")
            preserved=grading_run["items"][0]["attempts"][-1]
            assert_ok(preserved["ended_at"] is not None and preserved["output"]=="candidate answer","answer is checkpointed before grading begins")
            process.kill();process.wait();process=boot();delay_judge=False
            recovered=api("runs/"+grading_id)
            assert_ok(recovered["status"]=="interrupted" and recovered["items"][0]["status"]=="grading" and recovered["items"][0]["attempts"][-1]["error"] is None,"restart retains completed response awaiting grading")
            before=len(requests);api("runs/"+grading_id+"/resume",{});recovered=wait(grading_id)
            new_requests=requests[before:]
            assert_ok(len(new_requests)==1 and new_requests[0]["model"]=="judge-fixture" and len(recovered["items"][0]["attempts"])==1 and recovered["items"][0]["attempts"][0]["output"]==preserved["output"],"grading recovery reuses original answer without target inference")
            checkpoint_pack=copy.deepcopy(live);checkpoint_pack["id"]="checkpoint-fixture";checkpoint_pack["tasks"][0].update(id="checkpoint",prompt="checkpoint")
            api("packs",checkpoint_pack)
            checkpoint_config=copy.deepcopy(live_config);checkpoint_config.update(pack_id=checkpoint_pack["id"],timeout_s=15)
            checkpoint_release.clear()
            checkpoint_id=api("runs",{"config":checkpoint_config})["id"];ttft=wait_live_ttft(checkpoint_id)
            deadline=time.monotonic()+7
            with sqlite3.connect(Path(data,"app.sqlite3")) as conn:
                while time.monotonic()<deadline:
                    row=conn.execute("SELECT body FROM run_items WHERE run_id=? AND position=0",(checkpoint_id,)).fetchone()
                    checkpoint=json.loads(row[0]) if row else None
                    if checkpoint and checkpoint["attempts"] and checkpoint["attempts"][-1]["output"]=="ok":break
                    time.sleep(.05)
                else:raise AssertionError("partial answer checkpoint missing after five-second interval")
            assert_ok(checkpoint["status"]=="running" and checkpoint["attempts"][-1]["ended_at"] is None,"five-second checkpoint persists partial answer during streaming")
            process.kill();process.wait();checkpoint_release.set();process=boot();checkpoint_run=api("runs/"+checkpoint_id)
            partial=checkpoint_run["items"][0]["attempts"][-1]
            # JSON float parsing may differ by one ULP. Tolerance is far below
            # one nanosecond in these millisecond measurements; timestamps stay exact.
            assert_ok(checkpoint_run["status"]=="interrupted" and checkpoint_run["items"][0]["status"]=="pending" and partial["output"]=="ok" and math.isclose(partial["metrics"]["ttft_ms"],ttft,rel_tol=1e-14,abs_tol=1e-12) and partial["started_at"]==checkpoint["attempts"][-1]["started_at"] and partial["error"] is not None,f"restart preserves checkpointed partial response and measured TTFT (observed={checkpoint_run['status']}/{checkpoint_run['items'][0]['status']}, ttft={partial['metrics']['ttft_ms']}/{ttft})")
            checkpoint_release.clear()
            failure_id=api("runs",{"config":checkpoint_config})["id"];wait_live_ttft(failure_id)
            # Inject a write failure only into this synthetic run's temporary DB.
            with sqlite3.connect(Path(data,"app.sqlite3")) as conn:
                conn.execute(f"CREATE TRIGGER fixture_write_failure BEFORE UPDATE ON run_items WHEN NEW.run_id='{failure_id}' BEGIN SELECT RAISE(FAIL, 'fixture write failure'); END")
            failed=wait(failure_id,("interrupted",),timeout=10)
            failed_item=failed["items"][0]
            assert_ok(failed_item["status"]=="pending" and failed_item["attempts"][-1]["ended_at"] is not None and failed_item["attempts"][-1]["error"] is not None,"checkpoint failure leaves interrupted item resumable")
            checkpoint_release.set()
            with sqlite3.connect(Path(data,"app.sqlite3")) as conn:
                conn.execute("DROP TRIGGER fixture_write_failure")
            api("runs/"+failure_id+"/resume",{});repaired=wait(failure_id)
            assert_ok(repaired["summary"]["completed"]==1 and repaired["summary"]["errors"]==0 and len(repaired["items"][0]["attempts"])==2,"execution resumes after storage recovers without skipping failed item")
            # A failed resume/retry/rescore transition must not reserve the active slot.
            # Imports below are copies of synthetic fixtures, never production records.
            for action in ("resume", "retry", "rescore"):
                source=copy.deepcopy(api("export/"+saved_id))
                source["config"].update(judge=None,judge_connection_id="",telemetry_url="",device_id="",device=None)
                source["items"]=[copy.deepcopy(pack["tasks"][0])]
                source["items"]=[{"task":source["items"][0],"status":"done","attempts":[{
                    "started_at":datetime.now(timezone.utc).isoformat(),"ended_at":datetime.now(timezone.utc).isoformat(),
                    "output":"#### 42","reasoning":"","finish_reason":"stop","error":None,
                    "metrics":{"wall_ms":1,"decode_source":"unavailable","prefill_source":"unavailable"},
                    "score":{"state":"scored","value":1,"detail":"fixture","scorer_version":"fixture"},"raw":[]}]}]
                source["status"]="completed" if action=="rescore" else "paused"
                if action=="resume":source["items"][0].update(status="pending",attempts=[])
                if action=="retry":source["items"][0]["status"]="error";source["items"][0]["attempts"][0]["error"]="fixture failed request"
                transition_id=api("import",source)["id"]
                original=api("runs/"+transition_id)
                before=len(requests)
                with sqlite3.connect(Path(data,"app.sqlite3")) as conn:
                    conn.execute(f"CREATE TRIGGER control_write_failure BEFORE UPDATE ON runs WHEN NEW.id='{transition_id}' BEGIN SELECT RAISE(FAIL, 'control write failure'); END")
                try:
                    api("runs/"+transition_id+"/"+action,{"api_key":""})
                    raise AssertionError("control storage failure was not returned")
                except urllib.error.HTTPError as exc:
                    assert_ok(exc.code==400,f"{action} reports failed durable transition")
                after=api("runs/"+transition_id)
                assert_ok(after["status"]==original["status"] and after["error"]==original["error"] and [i["status"] for i in after["items"]]==[i["status"] for i in original["items"]] and len(requests)==before,f"{action} save failure restores run and item states without model calls")
                with sqlite3.connect(Path(data,"app.sqlite3")) as conn:
                    conn.execute("DROP TRIGGER control_write_failure")
                # Another run must start without restarting the app or cancelling a phantom job.
                probe_id=api("runs",{"config":ui_config,"connection_id":saved["id"]})["id"];wait(probe_id)
                assert_ok(api("runs/"+probe_id)["status"]=="completed",f"{action} save failure leaves active slot available")
                api("runs/"+transition_id+"/"+action,{"api_key":""});wait(transition_id)
                assert_ok(api("runs/"+transition_id)["status"]=="completed",f"{action} succeeds after storage recovers without app restart")
            api(f"connections/{saved['id']}/delete",{})
            process.terminate();process.wait();process=boot()
            before=len(requests);api("runs/"+saved_id+"/rescore",{});rescored=wait(saved_id)
            assert_ok(len(requests[before:])==1 and requests[before]["model"]=="judge-fixture" and rescored["summary"]["score_errors"]==0,"rescore after restart needs no deleted target connection")
            db=Path(data,"app.sqlite3").read_bytes()
            assert_ok(all(secret not in db for secret in [b"SECRET-TARGET",b"SECRET-JUDGE",b"PERSIST-TARGET",b"PERSIST-JUDGE"]),"keys absent from persisted database")
            (ROOT/"evidence/integration.json").write_text(json.dumps({"passed":len(checks),"checks":checks,"source":"synthetic API fixture; not benchmark measurements"},ensure_ascii=False,indent=2))
            print(json.dumps({"passed":len(checks),"checks":checks},ensure_ascii=False))
        finally:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
            log.close();fixture.shutdown()

if __name__=="__main__":
    (ROOT/"evidence").mkdir(exist_ok=True)
    main()
