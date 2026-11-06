#!/usr/bin/env python3
"""One JSON request -> one JSON score. Submissions never execute on the host."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor"))


class EnvironmentFailure(RuntimeError):
    def __init__(self, code, message, remedy, diagnostic=""):
        super().__init__(message)
        self.extra = {"error_code": code, "remedy": remedy,
                      "diagnostic": safe_diagnostic(diagnostic)}


def safe_diagnostic(text):
    # Keep useful failure evidence without publishing the host user/socket path.
    text = str(text).replace(str(Path.home()), "<home>")
    text = re.sub(r"(?:unix://)?/(?:Users|home|var/folders)/[^\s:'\"\n]+", "<local-path>", text)
    text = re.sub(r"(?i)(bearer\s+|token[=:]\s*|password[=:]\s*)\S+", r"\1<redacted>", text)
    return text[-2000:]


def docker_failure(code, stderr):
    text = stderr.lower()
    if "permission denied" in text:
        return EnvironmentFailure("docker_permission", "Docker 접근 권한이 없어 채점하지 못했습니다",
                                  "앱 실행 계정의 Docker 접근 권한을 확인하세요.", stderr)
    if any(s in text for s in ("failed to connect", "cannot connect", "is the docker daemon running", "connection refused")):
        return EnvironmentFailure("docker_unavailable", "Docker 실행 환경에 연결할 수 없습니다",
                                  "Docker Desktop 또는 Colima를 시작한 뒤 준비 상태를 다시 확인하세요.", stderr)
    if any(s in text for s in ("no such image", "unable to find image", "pull access denied")):
        return EnvironmentFailure("image_missing", "코드 채점 이미지가 준비되지 않았습니다",
                                  "다운로드한 앱의 ‘코드 채점 준비’ 스크립트를 실행하세요. 다른 과목은 Docker 없이 시험할 수 있습니다.", stderr)
    if any(s in text for s in ("no space left", "input/output error", "read-only file system")):
        return EnvironmentFailure("docker_storage", "Docker 저장소 오류로 채점하지 못했습니다",
                                  "호스트·Docker 저장소의 여유 공간과 디스크 상태를 확인하세요.", stderr)
    if "modulenotfounderror" in text or "importerror" in text:
        return EnvironmentFailure("dependency_missing", "코드 채점 이미지의 Python 의존성이 누락됐습니다",
                                  "지정된 Dockerfile로 채점 이미지를 다시 준비하세요.", stderr)
    return EnvironmentFailure("container_failed", f"코드 채점 환경이 종료됐습니다 (exit {code})",
                              "채점 환경 상세 진단을 확인하고 준비 상태 검사를 다시 실행하세요.", stderr)


def math_timeout_settings():
    # Math-Verify 0.9.0's Windows timer pickles a nested function and fails
    # under spawn. The product already runs this entire bridge in a disposable
    # process with a Rust deadline (45s grading / 35s readiness, kill_on_drop).
    # Disable only that incompatible inner timer, not parsing or equivalence.
    if sys.platform == "win32":
        return {"parsing_timeout": 0}, {"timeout_seconds": 0}
    return {}, {}


def result(ok, detail, version, extra=None):
    return {"value": int(bool(ok)), "state": "scored", "detail": detail,
            "scorer_version": version, "extra": extra or {}}


def extract_code(output):
    blocks = re.findall(r"```(?:python|py)?[ \t]*\n(.*?)```", output, re.S | re.I)
    if blocks:
        return blocks[-1]
    return output.split("[BEGIN]")[-1].split("[DONE]")[0].strip("\n")


def container_run(payload, driver, lcb=False):
    name = os.environ.get("BENCH_CONTAINER_NAME", "llm-bench-" + uuid.uuid4().hex)
    if not re.fullmatch(r"llm-bench-[a-f0-9]{32}", name):
        raise ValueError("invalid grader container name")
    image = os.environ.get("BENCH_LCB_IMAGE", "llm-bench-code:py311") if lcb else os.environ.get("BENCH_CODE_IMAGE", "python@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79")
    # Resolve even an explicit tag to an immutable local ID before executing.
    # Inspection never downloads an image. Keep only ID/platform in score evidence.
    try:
        inspected = subprocess.run(["docker", "image", "inspect", image], capture_output=True, text=True, timeout=10)
        if inspected.returncode:
            raise docker_failure(inspected.returncode, inspected.stderr)
        info = json.loads(inspected.stdout)[0]
        image = info["Id"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise ValueError("invalid immutable grader image ID")
        environment = {"image_id": image, "architecture": info.get("Architecture"), "os": info.get("Os")}
    except FileNotFoundError:
        raise EnvironmentFailure("docker_missing", "코드 채점용 Docker가 설치되지 않았습니다", "코드 시험을 사용할 때만 Docker를 별도로 설치하고 ‘코드 채점 준비’를 실행하세요. 다른 과목에는 Docker가 필요하지 않습니다.")
    except subprocess.TimeoutExpired:
        raise EnvironmentFailure("docker_inspect_timeout", "채점 이미지 확인 제한시간 초과", "Docker 상태를 확인한 뒤 다시 시도하세요.")
    command = ["docker", "run", "--name", name, "--rm", "--pull=never", "-i",
               "--network=none", "--read-only", "--cap-drop=ALL",
               "--security-opt=no-new-privileges", "--pids-limit=32",
               "--memory=768m" if lcb else "--memory=256m", "--cpus=1",
               "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
               image, "python", "-I", "-c", driver]
    # No mounts, credentials, network, shell, image auto-pull or host fallback.
    try:
        run = subprocess.run(command, input=json.dumps(payload), text=True,
                             capture_output=True, timeout=600 if lcb else 20)
        if run.returncode:
            raise docker_failure(run.returncode, run.stderr)
        try:
            graded = json.loads(run.stdout)
            graded["grader_environment"] = environment
            return graded
        except json.JSONDecodeError:
            raise EnvironmentFailure("invalid_grader_output", "코드 채점기가 판정 결과를 반환하지 않았습니다",
                                     "채점 이미지·공식 채점기 준비 상태를 확인하세요.", run.stderr)
    except FileNotFoundError:
        raise EnvironmentFailure("docker_missing", "코드 채점용 Docker가 설치되지 않았습니다",
                                 "코드 시험을 사용할 때만 Docker를 별도로 설치하고 ‘코드 채점 준비’를 실행하세요. 다른 과목에는 Docker가 필요하지 않습니다.")
    except subprocess.TimeoutExpired:
        raise EnvironmentFailure("container_timeout", "코드 채점 환경 전체 제한시간 초과; 점수 미산출",
                                 "코드 문항 시간 초과와 다른 환경 오류입니다. Docker 상태와 채점기 진단을 확인하세요.")
    finally:
        try:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass


HUMAN_DRIVER = '''import json,sys,builtins
request=json.load(sys.stdin)
namespace={'__name__':'official_humaneval','__builtins__':vars(builtins).copy()}
exec(compile(request['official'], '<official-humaneval>', 'exec'), namespace)
print(json.dumps(namespace['check_correctness'](request['problem'], request['solution'], 10)))
'''

LCB_DRIVER = '''import json,sys,gzip,base64,pickle,zlib,contextlib,io,builtins
request=json.load(sys.stdin)
namespace={'__name__':'official_livecodebench','__builtins__':vars(builtins).copy()}
exec(compile(request['official'], '<official-livecodebench>', 'exec'), namespace)
def decode(value):
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return json.loads(pickle.loads(zlib.decompress(base64.b64decode(value))))
tests=decode(request['tests']['public_test_cases'])+decode(request['tests']['private_test_cases'])
metadata=json.loads(request['tests']['metadata'])
sample={'input_output':json.dumps({'inputs':[t['input'] for t in tests], 'outputs':[t['output'] for t in tests], 'fn_name':metadata.get('func_name')})}
with contextlib.redirect_stdout(io.StringIO()):
    checks,details=namespace['run_test'](sample,test=request['solution'],debug=False,timeout=8)
checks=[v.item() if hasattr(v,'item') else v for v in checks]
print(json.dumps({'passed':bool(checks) and all(v is True or v==1 for v in checks), 'test_results':checks, 'metadata':details, 'test_count':len(tests)}, default=str))
'''


def evaluate(task, output):
    scorer = task["scorer"]
    if scorer == "ifeval":
        import langdetect
        langdetect.DetectorFactory.seed = 0
        from instruction_following_eval import evaluation_lib as official
        meta = task["meta"]
        inp = official.InputExample(key=meta["key"], instruction_id_list=meta["instruction_id_list"], prompt=task["prompt"], kwargs=meta["kwargs"])
        strict = official.test_instruction_following_strict(inp, {inp.prompt: output})
        loose = official.test_instruction_following_loose(inp, {inp.prompt: output})
        return result(strict.follow_all_instructions,
                      f"공식 IFEval strict: {sum(strict.follow_instruction_list)}/{len(strict.follow_instruction_list)} 지시 준수",
                      "ifeval-107e3347-strict", {"strict": strict.follow_instruction_list, "loose": loose.follow_instruction_list, "loose_prompt": loose.follow_all_instructions})
    if scorer == "math":
        from math_verify import parse, verify, LatexExtractionConfig, ExprExtractionConfig
        config = (LatexExtractionConfig(), ExprExtractionConfig())
        parse_options, verify_options = math_timeout_settings()
        gold = parse("$\\boxed{" + str(task["answer"]) + "}$", extraction_config=config, **parse_options)
        predicted = parse(output, extraction_config=config, **parse_options)
        if not gold:
            raise ValueError("MATH 정답 파싱 실패; 문항을 오답으로 처리하지 않음")
        extra = {"reference_parsed": str(gold), "candidate_parsed": str(predicted)}
        if parse_options:
            extra["timeout_policy"] = "windows-bridge-process-45s; inner Math-Verify timers disabled"
        return result(bool(predicted) and verify(gold, predicted, **verify_options),
                      "Math-Verify 수식 동치 비교 (원본 MATH 채점기와 별도)",
                      "math-verify-0.9.0", extra)
    if scorer in ("humaneval", "mbpp"):
        code = extract_code(output)
        if scorer == "humaneval":
            entry = task["meta"]["entry_point"]
            solution = code if re.search(r"def\s+" + re.escape(entry) + r"\s*\(", code) else task["prompt"] + code
            problem = {"task_id":task["id"], "prompt":"", "test":task["meta"]["test"], "entry_point":entry}
        else:
            tests = task["meta"].get("test_setup_code", "") + "\n" + "\n".join(task["meta"]["test_list"])
            problem = {"task_id":task["id"], "prompt":"", "entry_point":"__mbpp_candidate",
                       "test":"def check(candidate):\n" + "\n".join("    " + line for line in tests.splitlines())}
            solution = code + "\n__mbpp_candidate = None\n"
        graded = container_run({"official":(ROOT/"vendor/humaneval_execution.py").read_text(), "problem":problem, "solution":solution}, HUMAN_DRIVER)
        version = "humaneval-6d43fb98-official-v1" if scorer == "humaneval" else "mbpp-f82046ba-official-assertions-docker-v1"
        return result(graded["passed"], f"{scorer}: {graded['result']}", version, graded)
    if scorer == "livecodebench":
        path = (ROOT.parent / task["meta"]["tests_file"]).resolve()
        allowed = (ROOT.parent / "datasets/sources/livecodebench-v6-tests").resolve()
        if not path.is_relative_to(allowed):
            raise ValueError("LiveCodeBench 테스트 경로가 허용된 자료 폴더 밖에 있음")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != task["meta"]["tests_sha256"]:
            raise ValueError("LiveCodeBench 테스트 파일 해시 불일치")
        # Pickle decoding occurs ONLY inside the offline container.
        tests = json.loads(gzip.decompress(raw))
        graded = container_run({"official":(ROOT/"vendor/livecodebench/testing_util.py").read_text(), "tests":tests, "solution":extract_code(output)}, LCB_DRIVER, lcb=True)
        return result(graded["passed"], f"공식 LiveCodeBench 테스트: {sum(v is True or v == 1 for v in graded['test_results'])}/{graded['test_count']}", "livecodebench-28fef95e-run-test-v1", graded)
    raise ValueError("unsupported scorer")


def readiness(scorers):
    states = {}
    shared_code = None
    for scorer in dict.fromkeys(scorers):
        try:
            if scorer == "ifeval":
                from instruction_following_eval import evaluation_lib
                import nltk
                nltk.data.find("tokenizers/punkt_tab/english/")
                import langdetect
            elif scorer == "math":
                from math_verify import parse, verify
                parse_options, verify_options = math_timeout_settings()
                if not verify(parse("1", **parse_options), parse("1", **parse_options), **verify_options):
                    raise RuntimeError("Math-Verify self-test failed")
            elif scorer in ("humaneval", "mbpp"):
                if shared_code is None:
                    sample = {"id":"readiness", "scorer":"humaneval", "prompt":"", "meta":{
                        "entry_point":"identity", "test":"def check(candidate):\n    assert candidate(7) == 7"}}
                    shared_code = evaluate(sample, "def identity(x):\n    return x")
                if shared_code["value"] != 1:
                    raise EnvironmentFailure("grader_self_test", "공식 코드 채점기의 정상 답안 검증이 실패했습니다",
                                             "Docker 이미지와 공식 채점기 진단을 확인하세요.", shared_code["detail"])
            elif scorer == "livecodebench":
                tests = {"public_test_cases":json.dumps([{"input":"7\n", "output":"7\n"}]),
                         "private_test_cases":"[]", "metadata":"{}"}
                v = container_run({"official":(ROOT/"vendor/livecodebench/testing_util.py").read_text(),
                                   "tests":tests, "solution":"print(input())"}, LCB_DRIVER, lcb=True)
                if not v["passed"]:
                    raise EnvironmentFailure("grader_self_test", "공식 LiveCodeBench 채점기 정상 답안 검증이 실패했습니다",
                                             "Docker 이미지와 공식 채점기 진단을 확인하세요.", str(v))
            elif scorer not in ("numeric", "choice", "exact", "json"):
                raise EnvironmentFailure("unsupported_scorer", f"지원하지 않는 채점기: {scorer}", "평가팩의 채점기 설정을 확인하세요.")
            states[scorer] = {"available":True, "error":None, "error_code":None,
                              "remedy":None, "verification":"official_self_test" if scorer in ("humaneval", "mbpp", "livecodebench") else "dependency_check"}
        except Exception as exc:
            states[scorer] = {"available":False, "error":safe_diagnostic(str(exc)), **getattr(exc, "extra", {
                "error_code":"dependency_missing", "remedy":"scorers/requirements.txt와 채점용 자료를 준비하세요.",
                "diagnostic":safe_diagnostic(f"{type(exc).__name__}: {exc}")})}
    return {"scorers":states}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        score = readiness(request["scorers"]) if request.get("action") == "readiness" else evaluate(request["task"], request["output"])
    except Exception as exc:
        score = {"value": None, "state": "unavailable", "detail":safe_diagnostic(f"{type(exc).__name__}: {exc}"), "scorer_version": "bridge-v3",
                 "extra":getattr(exc, "extra", {"error_code":"grader_error", "diagnostic":safe_diagnostic(str(exc))})}
    print(json.dumps(score, ensure_ascii=False))
