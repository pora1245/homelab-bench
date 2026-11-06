#!/usr/bin/env python3
"""Official code graders in real offline containers; isolated HTTP fixture, no model.

Run after cargo build: .venv/bin/python tests/code_scoring_contract.py
Existing app/database/model endpoints are never used or modified.
"""
import copy
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scorers"))
import bridge

checks = []
requests = []
def check(ok, name):
    assert ok, name
    checks.append(name)

def docker(*args):
    return subprocess.run(["docker", *args], text=True, capture_output=True, timeout=10)

def container_names():
    r = docker("ps", "-aq", "--filter", "name=llm-bench-")
    assert r.returncode == 0, r.stderr
    return r.stdout.split()

def task():
    return {"id":"fixture-code", "subject":"function", "prompt":"Implement f(x) returning x+1.",
            "answer":"official assertions", "scorer":"humaneval", "max_tokens":128,
            "meta":{"entry_point":"f", "test":"def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(-1) == 0"}}

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        code="def f(x):\n    while True: pass" if "SLOW" in body["messages"][0]["content"] else "def f(x):\n    return x+1"
        self.send_response(200);self.send_header("Content-Type","text/event-stream");self.end_headers()
        v={"choices":[{"delta":{"content":code},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":20}}
        self.wfile.write(("data: "+json.dumps(v)+"\n\ndata: [DONE]\n\n").encode())

def main():
    existing=set(container_names())
    ready=bridge.readiness(["humaneval","mbpp","livecodebench"])
    check(all(v["available"] for v in ready["scorers"].values()),"official self-tests for three code graders pass")
    good=bridge.evaluate(task(),"```python\ndef f(x):\n    return x+1\n```")
    check(good["value"]==1 and good["state"]=="scored","HumanEval valid function passes")
    bad=bridge.evaluate(task(),"def f(x):\n    return x")
    check(bad["value"]==0 and bad["state"]=="scored","HumanEval assertion failure is incorrect, not environment failure")
    timeout=bridge.evaluate(task(),"def f(x):\n    while True: pass")
    check(timeout["value"]==0 and "timed out" in timeout["detail"],"candidate time limit yields a scored failure")
    mbpp={**task(),"scorer":"mbpp","meta":{"test_list":["assert f(1) == 2","assert f(-1) == 0"]}}
    check(bridge.evaluate(mbpp,"def f(x): return x+1")["value"]==1 and bridge.evaluate(mbpp,"def f(x): return 0")["value"]==0,"MBPP official assertions distinguish correct and incorrect")
    payload={"official":(ROOT/"scorers/vendor/livecodebench/testing_util.py").read_text(),
             "tests":{"public_test_cases":json.dumps([{"input":"7\n","output":"7\n"}]),"private_test_cases":"[]","metadata":"{}"},"solution":"print(input())"}
    ok=bridge.container_run(payload,bridge.LCB_DRIVER,lcb=True)
    payload["solution"]="print(9)"
    no=bridge.container_run(payload,bridge.LCB_DRIVER,lcb=True)
    check(ok["passed"] and not no["passed"],"LiveCodeBench official tests distinguish correct and incorrect")
    missing_env=dict(os.environ,DOCKER_HOST="unix:///tmp/llm-bench-no-such-docker.sock")
    missing_env.pop("DOCKER_CONTEXT",None)
    r=subprocess.run([sys.executable,"scorers/bridge.py"],cwd=ROOT,env=missing_env,input=json.dumps({"task":task(),"output":"def f(x): return x+1"}),text=True,capture_output=True,timeout=10)
    unavailable=json.loads(r.stdout)
    check(unavailable["value"] is None and unavailable["extra"]["error_code"]=="docker_unavailable","missing daemon yields explicit unavailable cause and no zero score")
    check(unavailable["extra"]["remedy"] and str(Path.home()) not in json.dumps(unavailable),"environment remedy is present and host user path is absent")
    image_env=dict(os.environ,BENCH_CODE_IMAGE="llm-bench-missing-image:contract-do-not-pull")
    r=subprocess.run([sys.executable,"scorers/bridge.py"],cwd=ROOT,env=image_env,input=json.dumps({"task":task(),"output":"def f(x): return x+1"}),text=True,capture_output=True,timeout=10)
    unavailable=json.loads(r.stdout)
    check(unavailable["value"] is None and unavailable["extra"]["error_code"]=="image_missing","missing image is explicit and never auto-pulled")
    fixture=http.server.ThreadingHTTPServer(("127.0.0.1",0),Fixture)
    threading.Thread(target=fixture.serve_forever,daemon=True).start()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0));port=sock.getsockname()[1]
    base=f"http://127.0.0.1:{port}/api/"
    def api(path,body=None):
        req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(req,timeout=45) as r:return json.load(r)
    def wait(predicate, timeout=15):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            value=predicate()
            if value:return value
            time.sleep(.1)
        raise AssertionError("wait condition timed out")
    with tempfile.TemporaryDirectory(prefix="llm-bench-code-contract-") as data:
        env=dict(os.environ,BENCH_DATA_DIR=data,BENCH_PORT=str(port))
        log=open(ROOT/"evidence/code-contract-server.log","w")
        def boot(extra=None):
            process=subprocess.Popen([str(ROOT/"target/debug/llm-bench")],cwd=ROOT,env={**env,**(extra or {})},stdout=log,stderr=log)
            def health():
                try:return api("health")["ok"]
                except (OSError,ValueError):return False
            wait(health)
            return process
        process=boot({"BENCH_CODE_IMAGE":"llm-bench-missing-image:contract-do-not-pull"})
        try:
            pack={"id":"code-fixture-v1","name":"Code fixture","version":"1","sources":{"type":"synthetic"},"tasks":[task()]}
            api("packs",pack)
            config={"name":"Code fixture","base_url":f"http://127.0.0.1:{fixture.server_port}/v1","model":"fixture","pack_id":pack["id"],"profile":"full","temperature":0,"max_tokens":128,"concurrency":1,"timeout_s":20}
            try:api("runs",{"config":config});raise AssertionError("start accepted missing scorer")
            except urllib.error.HTTPError as e:
                rejected=json.load(e);check(e.code==400 and rejected["code"]=="scorer_not_ready" and not requests,"start rejects unavailable selected grader before any model request")
            process.terminate();process.wait(timeout=5);process=boot()
            rid=api("runs",{"config":config})["id"]
            r=wait(lambda:(lambda r:r if r["status"]=="completed" else None)(api("runs/"+rid)))
            check(r["summary"]["correct"]==1 and r["summary"]["grading_status"]=="completed","live fixture response is correctly collected and graded")
            # Preserve the exact original failed result, then re-score the saved answer.
            imported=copy.deepcopy(r);imported["id"]="contract-original-failure"
            for item in imported["items"]:
                for attempt in item["attempts"]: attempt["raw"] = []
            imported["items"][0]["attempts"][-1]["score"]={"value":None,"state":"unavailable","detail":"original exit 1","scorer_version":"bridge-v2","extra":{}}
            imported_id=api("import",imported)["id"]
            before=len(requests);api("runs/"+imported_id+"/rescore",{})
            rescored=wait(lambda:(lambda r:r if r["status"]=="completed" else None)(api("runs/"+imported_id)))
            score=rescored["items"][0]["attempts"][-1]["score"]
            check(len(requests)==before and score["value"]==1 and score["extra"]["grading_history"][0]["score"]["detail"]=="original exit 1","regrading uses saved answer with original failure history and no model request")
            slow=copy.deepcopy(pack);slow["id"]="slow-code-fixture";slow["tasks"][0]["prompt"]="SLOW "+slow["tasks"][0]["prompt"]
            api("packs",slow);slow_id=api("runs",{"config":{**config,"pack_id":slow["id"]}})["id"]
            wait(lambda:api("runs/"+slow_id)["items"][0]["status"]=="grading")
            ids=wait(lambda:list(set(container_names())-existing))
            inspection=json.loads(docker("inspect",ids[0]).stdout)[0]
            h=inspection["HostConfig"]
            check(inspection["Config"]["User"]=="65534:65534" and h["NetworkMode"]=="none" and h["ReadonlyRootfs"] and h["Memory"]==256*1024*1024 and h["PidsLimit"]==32 and h["NanoCpus"]==1_000_000_000 and "ALL" in h["CapDrop"] and not h["Binds"],"real grader has nonroot/offline/read-only/memory/PID/CPU/capability/no-bind isolation")
            api("runs/"+slow_id+"/cancel",{})
            cancelled=wait(lambda:(lambda r:r if r["status"]=="cancelled" else None)(api("runs/"+slow_id)))
            check(not (set(container_names())-existing),"cancel waits for grading container reclamation")
            check(cancelled["items"][0]["status"]=="grading" and cancelled["items"][0]["attempts"][-1]["output"],"cancel preserves generated response for later grading")
        finally:
            process.terminate();process.wait(timeout=5);log.close();fixture.shutdown()
    check(not (set(container_names())-existing),"all fixture containers reclaimed")
    result={"passed":len(checks),"checks":checks,"scope":"synthetic fixtures; no actual model calls; official graders inside Docker"}
    (ROOT/"evidence/code-scoring-contract.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=="__main__":main()
