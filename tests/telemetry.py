#!/usr/bin/env python3
"""Telemetry contracts; optional --ssh ALIAS performs only read-only hardware queries."""
import argparse
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]

class Sensor(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        data={"timestamp":datetime.now(timezone.utc).isoformat(),"host":"PRIVATE-HOST","ip":"PRIVATE-IP",
              "cpu_model":"Fixture CPU","cpu_pct":20,"ram_total_bytes":1000,"ram_used_bytes":200,
              "gpus":[{"index":0,"name":"Fixture A","power_w":"25.5","uuid":"PRIVATE-UUID","serial":"PRIVATE-SERIAL"},
                      {"index":1,"name":"Fixture B","power_w":100}],
              "offload":{"numa_nodes":[{"index":0,"ram_total_bytes":1000,"ram_free_bytes":800}],
                         "storage":[{"index":0,"model":"Fixture SSD","serial":"PRIVATE-SERIAL","path":"PRIVATE-PATH","read_bytes_per_s":1234}],
                         "disk_read_bytes_per_s":1234,"read_interval_ms":250}}
        self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(json.dumps(data).encode())

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--ssh");args=parser.parse_args()
    with socket.socket() as sock:sock.bind(("127.0.0.1",0));port=sock.getsockname()[1]
    base=f"http://127.0.0.1:{port}/api/"
    checks=[]
    def check(value,label):assert value,label;checks.append(label)
    def api(path,body=None):
        request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(request,timeout=15) as response:return json.load(response)
    fixture=http.server.ThreadingHTTPServer(("127.0.0.1",0),Sensor)
    threading.Thread(target=fixture.serve_forever,daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="llm-bench-telemetry-") as data:
        with open(Path(data)/"server.log","w") as log:
            process=subprocess.Popen([str(ROOT/"target/debug/llm-bench")],cwd=ROOT,env=dict(os.environ,BENCH_DATA_DIR=data,BENCH_PORT=str(port)),stdout=log,stderr=log)
            try:
                for _ in range(200):
                    try:api("health");break
                    except OSError:time.sleep(.05)
                else:raise AssertionError("startup failed")
                d=api("devices",{"name":"Fixture","mode":"http","url":f"http://127.0.0.1:{fixture.server_port}/metrics","gpu_indices":[0]})
                sample=api(f"devices/{d['id']}/sample");v=sample["data"]
                check(sample["status"]=="connected" and len(v["gpus"])==1 and v["gpus"][0]["power_w"]==25.5,"selected GPU alone supplies numeric measurements")
                check("PRIVATE-" not in json.dumps(v),"sample excludes private host IP UUID serial and storage path")
                check(v["gpus"][0]["temperature_c"] is None and "temperature_c" in v["gpus"][0]["unavailable"],"unsupported metric is null with reason")
                check(v["offload"] is None,"offload details remain opt-in")
                d.update(include_offload=True);api("devices",d);v=api(f"devices/{d['id']}/sample")["data"]
                check(v["offload"]["disk_read_bytes_per_s"]==1234 and "PRIVATE-" not in json.dumps(v),"offload reads keep measured throughput and remove device identities")
                d.update(gpu_indices=[8]);api("devices",d);sample=api(f"devices/{d['id']}/sample")
                check(sample["status"]=="partial" and sample["data"]["gpus"]==[] and sample["data"]["gpu_selection"]["missing_indices"]==[8],"missing selected GPU cannot become another GPU silently")
                remote=None
                if args.ssh:
                    d=api("devices",{"name":"Read-only server sample","mode":"ssh","host":args.ssh,"gpu_indices":[0],"include_offload":True})
                    sample=api(f"devices/{d['id']}/sample");remote=sample["data"]
                    check(sample["status"]=="connected" and remote["gpu_selection"]["observed_indices"]==[0],"SSH read-only sample selects GPU 0")
                    check(remote["gpus"][0]["driver_version"] is not None and remote["gpus"][0]["power_limit_w"] is not None,"SSH driver PCIe clock power and throttle fields collected")
                    check(remote["cpu_model"] is not None and remote["swap_total_bytes"] is not None,"SSH CPU cores RAM and swap collected")
                    check(remote["offload"]["numa_nodes"] and remote["offload"]["storage"] and remote["offload"]["disk_read_bytes_per_s"] is not None,"SSH optional NUMA storage and interval disk reads collected")
                result={"passed":len(checks),"checks":checks,"scope":"sensor fixture plus optional read-only SSH; no model inference","remote_sample":remote}
                (ROOT/"evidence/telemetry-validation.json").write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
            finally:
                process.terminate();process.wait(timeout=10);fixture.shutdown()

if __name__=="__main__":main()
