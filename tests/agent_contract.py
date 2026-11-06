#!/usr/bin/env python3
"""Standalone sensor HTTP contract using a temporary fake nvidia-smi, never a model."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]

def main():
    with socket.socket() as sock:sock.bind(("127.0.0.1",0));port=sock.getsockname()[1]
    url=f"http://127.0.0.1:{port}/metrics"
    checks=[]
    def check(value,label):assert value,label;checks.append(label)
    def sample():
        start=time.monotonic()
        with urllib.request.urlopen(url,timeout=2) as response:data=json.load(response)
        check(time.monotonic()-start<2,"metrics endpoint responds while collector runs")
        return data
    with tempfile.TemporaryDirectory(prefix="bench-agent-contract-") as tmp:
        tmp=Path(tmp);binary=tmp/"nvidia-smi";hang=tmp/"hang";started=tmp/"started"
        binary.write_text('''#!/bin/sh
if [ -f "$BENCH_FIXTURE_HANG" ]; then
    touch "$BENCH_FIXTURE_STARTED"
    exec sleep 20
fi
printf '%s\\n' '0, NVIDIA Fixture, 30, 1000, 12000, 45, 50, 1100, 555.11, 4, 16, 7000, 170, 0x0000000000000000'
''');binary.chmod(0o700)
        env=dict(os.environ,PATH=str(tmp)+os.pathsep+os.environ["PATH"],BENCH_AGENT_BIND=f"127.0.0.1:{port}",BENCH_AGENT_OFFLOAD="0",BENCH_FIXTURE_HANG=str(hang),BENCH_FIXTURE_STARTED=str(started))
        with open(tmp/"agent.log","w") as log:
            process=subprocess.Popen([str(ROOT/"target/debug/llm-bench"),"agent"],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+8
                while time.monotonic()<deadline:
                    try:
                        first=sample()
                        if first.get("timestamp"):break
                    except OSError:pass
                    time.sleep(.05)
                else:raise AssertionError("agent initial sample missing")
                check(first["source"]=="bench-agent" and first["gpus"][0]["name"]=="NVIDIA Fixture","agent uses shared extended collector")
                check(first["gpus"][0]["driver_version"]=="555.11" and first["gpus"][0]["pcie_width"]==16 and first["gpus"][0]["power_limit_w"]==170,"agent exposes driver PCIe and power limit")
                check(first["cpu_logical_cores"]>0 and first["swap_total_bytes"] is not None and first["offload"] is None,"agent includes host fields and respects offload opt-in")
                check(all(key not in first for key in ["host","ip","uuid","serial"]),"agent sample has no host identity fields")
                hang.touch();deadline=time.monotonic()+3
                while not started.exists() and time.monotonic()<deadline:time.sleep(.05)
                check(started.exists(),"blocking collector fixture entered")
                # While the fake command sleeps, old metrics must still be readable.
                held=sample();check(held.get("timestamp")==first["timestamp"],"last good sample remains readable during collection delay")
                deadline=time.monotonic()+9
                while time.monotonic()<deadline:
                    current=sample()
                    if current.get("status")=="unavailable":break
                    time.sleep(.2)
                else:raise AssertionError("seven-second collection timeout did not publish unavailable")
                check("timestamp" not in current,"timeout does not publish a fresh timestamp for stale readings")
                hang.unlink();deadline=time.monotonic()+4
                while time.monotonic()<deadline:
                    recovered=sample()
                    if recovered.get("timestamp") and recovered["timestamp"]!=first["timestamp"]:break
                    time.sleep(.1)
                else:raise AssertionError("collector did not recover after timeout")
                check(recovered["gpus"][0]["driver_version"]=="555.11","agent resumes collection after timeout")
                unique=list(dict.fromkeys(checks));result={"passed":len(unique),"checks":unique,"scope":"isolated local agent with fake nvidia-smi; no production restart or model inference"}
                (ROOT/"evidence/agent-contract.json").write_text(json.dumps(result,indent=2));print(json.dumps(result))
            finally:
                process.terminate();process.wait(timeout=10)

if __name__=="__main__":main()
