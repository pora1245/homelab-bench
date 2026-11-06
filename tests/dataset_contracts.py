#!/usr/bin/env python3
"""Full-source cardinality, provenance, scoring and sandbox contract checks.

Run with .venv/bin/python tests/dataset_contracts.py. Code execution checks are
explicitly skipped unless the offline Docker images already exist and run.
No model or generated code is ever executed on the host.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scorers"))
import bridge

COUNTS = {"gsm8k-test-v1":1319,"math500-test-v1":500,"mmlu-pro-test-v1":12032,
          "ifeval-full-v1":541,"humaneval-full-v1":164,"mbpp-test-v1":500,
          "livecodebench-v6-v1":1055,"korean-core-v1":32}


def pack(identifier):
    return json.loads((ROOT/"datasets"/(identifier+".json")).read_text())


def docker_ready(image):
    try:
        return subprocess.run(["docker","image","inspect",image],capture_output=True,timeout=5).returncode == 0
    except (FileNotFoundError,subprocess.TimeoutExpired):
        return False


class DatasetContracts(unittest.TestCase):
    def test_all_full_splits_and_reproducible_selection(self):
        for identifier,count in COUNTS.items():
            p=pack(identifier); tasks=p["tasks"]; ids=[t["id"] for t in tasks]; s=p["sources"]
            self.assertEqual(len(tasks),count,identifier)
            self.assertEqual(len(set(ids)),count)
            self.assertEqual((s["source_count"],s["installed_count"]),(count,count))
            self.assertEqual(len(s["quick_ids"]),s["quick_count"])
            self.assertEqual(len(set(s["quick_ids"])),s["quick_count"])
            self.assertTrue(set(s["quick_ids"]).issubset(ids))
            self.assertTrue(s["source_revision"])
            self.assertTrue(all(len(f["sha256"])==64 for f in s["source_files"]))
        mbpp=pack("mbpp-test-v1")
        self.assertEqual({t["meta"]["source_id"] for t in mbpp["tasks"]},set(range(11,511)))

    def test_evaluated_reference_code_not_in_prompts(self):
        for t in pack("humaneval-full-v1")["tasks"]:
            self.assertNotIn(t["meta"]["canonical_solution"].strip(), t["prompt"])
        for t in pack("mbpp-test-v1")["tasks"]:
            self.assertNotIn(t["meta"]["reference_code"].strip(), t["prompt"])
        for t in pack("livecodebench-v6-v1")["tasks"]:
            self.assertNotIn("private_test_cases",t["prompt"])
            self.assertNotIn("private_test_cases",t["meta"])

    def test_all_lcb_private_test_sidecars_present_and_integral(self):
        for t in pack("livecodebench-v6-v1")["tasks"]:
            p=ROOT/t["meta"]["tests_file"]
            self.assertTrue(p.is_file(),t["id"])
            h=hashlib.sha256()
            with p.open("rb") as f:
                for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
            self.assertEqual(h.hexdigest(),t["meta"]["tests_sha256"],t["id"])

    def test_math_equivalence_and_rejection(self):
        task={"scorer":"math","answer":"1/2"}
        self.assertEqual(bridge.evaluate(task,r"\boxed{0.5}")["value"],1)
        self.assertEqual(bridge.evaluate(task,r"\boxed{2}")["value"],0)
        self.assertEqual(bridge.evaluate(task,"I do not know")["value"],0)

    def test_every_math_reference_is_parseable(self):
        for t in pack("math500-test-v1")["tasks"]:
            self.assertEqual(bridge.evaluate(t,"$\\boxed{"+t["answer"]+"}$")["value"],1,t["id"])

    def test_ifeval_official_strict_and_loose(self):
        task={"scorer":"ifeval","prompt":"Say hello","meta":{"key":1,"instruction_id_list":["keywords:existence"],"kwargs":[{"keywords":["hello"]}]}}
        self.assertEqual(bridge.evaluate(task,"hello")["value"],1)
        self.assertEqual(bridge.evaluate(task,"world")["value"],0)

    def test_docker_failure_never_runs_solution_on_host(self):
        t=pack("mbpp-test-v1")["tasks"][0]
        calls=[]
        def fake(command,**kwargs):
            calls.append(command)
            if command[:3]==["docker","image","inspect"]:
                return subprocess.CompletedProcess(command,0,json.dumps([{"Id":"sha256:"+"a"*64,"Architecture":"arm64","Os":"linux"}]),"")
            return subprocess.CompletedProcess(command,125,"","")
        with patch.object(bridge.subprocess,"run",fake):
            with self.assertRaises(bridge.EnvironmentFailure) as error:
                bridge.evaluate(t,"raise Exception('must not run on host')")
        self.assertEqual(error.exception.extra["error_code"], "container_failed")
        self.assertTrue(all(c[0]=="docker" for c in calls))
        run=next(c for c in calls if c[:2]==["docker","run"])
        self.assertIn("--network=none",run);self.assertIn("--read-only",run)
        self.assertIn("--cap-drop=ALL",run);self.assertIn("--pull=never",run)
        self.assertFalse(any(c in ("-v","--mount") for c in run))

    def test_missing_image_stops_before_container_run(self):
        calls=[]
        def fake(command,**kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command,1,"","No such image")
        with patch.object(bridge.subprocess,"run",fake):
            with self.assertRaises(bridge.EnvironmentFailure) as error:
                bridge.evaluate(pack("mbpp-test-v1")["tasks"][0],"pass")
        self.assertEqual(error.exception.extra["error_code"],"image_missing")
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][:3],["docker","image","inspect"])

    def test_lcb_path_escape_is_rejected(self):
        with self.assertRaisesRegex(ValueError,"경로"):
            bridge.evaluate({"scorer":"livecodebench","meta":{"tests_file":"../BOARD.md","tests_sha256":"x"}},"pass")

    @unittest.skipUnless(docker_ready(os.environ.get("BENCH_CODE_IMAGE", "python@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79")),"Docker daemon/pinned Python image unavailable; no host execution fallback")
    def test_humaneval_mbpp_correct_and_wrong_in_sandbox(self):
        t=pack("humaneval-full-v1")["tasks"][0]
        self.assertEqual(bridge.evaluate(t,t["meta"]["canonical_solution"])["value"],1)
        self.assertEqual(bridge.evaluate(t,"    return None\n")["value"],0)
        t=pack("mbpp-test-v1")["tasks"][0]
        self.assertEqual(bridge.evaluate(t,t["meta"]["reference_code"])["value"],1)
        self.assertEqual(bridge.evaluate(t,"pass")["value"],0)

    @unittest.skipUnless(docker_ready("llm-bench-code:py311"),"Docker daemon/LCB numpy image unavailable; no host execution fallback")
    def test_lcb_official_correct_and_wrong_in_sandbox(self):
        # Official runner, tiny authored fixture, all tests kept inside container.
        payload={"official":(ROOT/"scorers/vendor/livecodebench/testing_util.py").read_text(),
                 "tests":{"public_test_cases":json.dumps([{"input":"2 3\n","output":"5\n"}]),"private_test_cases":json.dumps([{"input":"1 4\n","output":"5\n"}]),"metadata":"{}"},
                 "solution":"print(sum(map(int,input().split())))"}
        self.assertTrue(bridge.container_run(payload,bridge.LCB_DRIVER,lcb=True)["passed"])
        payload["solution"]="print(0)"
        self.assertFalse(bridge.container_run(payload,bridge.LCB_DRIVER,lcb=True)["passed"])


if __name__=="__main__":
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument("--json",type=Path,help="Write machine-readable validation evidence")
    args=parser.parse_args()
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DatasetContracts))
    if args.json:
        args.json.parent.mkdir(parents=True,exist_ok=True)
        args.json.write_text(json.dumps({"type":"dataset_and_scorer_contract_validation_not_model_scores","tests":result.testsRun,"passed":result.testsRun-len(result.errors)-len(result.failures)-len(result.skipped),"skipped":[{"test":t.id(),"reason":reason} for t,reason in result.skipped],"failures":[{"test":t.id(),"detail":detail} for t,detail in result.errors+result.failures],"pack_counts":COUNTS},ensure_ascii=False,indent=2)+"\n")
    sys.exit(not result.wasSuccessful())
