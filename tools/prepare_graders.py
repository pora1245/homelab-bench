#!/usr/bin/env python3
"""Prepare local non-code graders once; never installs Docker or runs a model."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]


def check(python, env, requirements):
    probe = """import importlib.metadata,json,sys
from pathlib import Path
for line in Path(sys.argv[1]).read_text().splitlines():
    line=line.strip()
    if not line or line.startswith('#'): continue
    name,version=line.split('==',1)
    assert importlib.metadata.version(name)==version, name+' version differs'
sys.path.insert(0,str(Path.cwd()/'scorers'))
import bridge
state=bridge.readiness(['ifeval','math'])
assert all(s['available'] for s in state['scorers'].values()), json.dumps(state)
print(json.dumps({'python':sys.version.split()[0],'scorers':state['scorers']}))
"""
    try:
        result = subprocess.run([str(python), "-c", probe, str(requirements)], cwd=ROOT,
                                env=env, capture_output=True, text=True, timeout=45)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11+ is required. Use the official Python installation helper.")
    data = args.data_dir.expanduser().resolve()
    requirements = ROOT / "scorers/requirements.txt"
    environment = ROOT / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if environment.exists() and not python.is_file():
        raise SystemExit("Existing .venv is invalid or belongs to another OS. Move it aside before setup.")
    data.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        data.chmod(0o700)
    nltk_data = Path(os.environ.get("NLTK_DATA", str(data / "nltk_data")))
    nltk_data.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({"NLTK_DATA": str(nltk_data), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    if not python.exists():
        print("Creating the app's private Python environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)
    state = check(python, env, requirements)
    if state is None:
        print("Preparing non-code graders and language resources (internet required)...", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(requirements)],
                       cwd=ROOT, env=env, check=True)
        subprocess.run([str(python), "-m", "nltk.downloader", "-d", str(nltk_data),
                        "punkt", "punkt_tab"], cwd=ROOT, env=env, check=True)
        state = check(python, env, requirements)
        if state is None:
            raise SystemExit("Non-code grader verification failed. The app can still use built-in packs; retry setup after checking its output.")
    (data / "grader-setup.json").write_text(json.dumps({
        "requirements_sha256": hashlib.sha256(requirements.read_bytes()).hexdigest(),
        "scope": "non-code graders only; Docker and OS-native sandbox not prepared",
        **state,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Ready: math and instruction-following graders. Code grading is optional and separate.")


if __name__ == "__main__":
    main()
