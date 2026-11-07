#!/usr/bin/env python3
"""Build local-only beta archives from explicit allowlists; never copy user data.
No publishing, model requests, or data downloads. Requires existing build tools.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
PACKS = []  # Resolved only from the reviewed distribution policy in main().
EXCLUDED_DATA_FILES = set()
COMMON_FILES = ["API.md", "datasets/README.md", "schemas/pack.schema.json", "scorers/bridge.py", "scorers/Dockerfile", "scorers/requirements.txt", "scorers/vendor/manifest.json", "tools/prepare_graders.py", "tools/import_full_datasets.py", "tools/import_bbh.py", "tools/audit_bbh_published_outputs.py", "tools/import-requirements.txt", "tests/bbh_contracts.py", "datasets/sources/download-manifest.json", "datasets/sources/bbh-manifest.json", "datasets/sources/bbh-published-results-manifest.json", "packaging/Start-LLM-Bench-Windows.ps1", "packaging/Setup-Graders-Windows.ps1", "packaging/Install-Python-Windows.ps1", "packaging/Setup-Code-Grader-Windows.ps1", "packaging/Start-LLM-Bench-Windows.cmd", "packaging/Setup-Graders-Windows.cmd", "packaging/Setup-Code-Grader-Windows.cmd"]
SOURCE_FILES = ["Cargo.toml", "Cargo.lock", "web/package.json", "web/package-lock.json", "web/tsconfig.json", "web/index.html", "tools/package_beta.py", "packaging/Build-Source-Windows.ps1", "packaging/Dockerfile.windows-build"]
SOURCE_FILES += ["tools/build_timed_packs.py", "tools/validate_timed_packs.py", "tools/prepare_screening.py"]
DOC_FILES = ["docs/BETA-START.md", "docs/WINDOWS-NATIVE-PREPARATION.md", "docs/BETA-REVIEW.md", "docs/BBH-PACK.md", "docs/bbh-validation.json", "docs/bbh-published-output-audit.json", "docs/THIRD-PARTY-NOTICES.md", "docs/DISTRIBUTION-LICENSE-AUDIT.md", "docs/python-dependencies.json", "docs/distribution-allowlist.json", "docs/rust-toolchain-notices.json", "docs/math500-source-equivalence.json", "docs/dataset-expansion-sources.json"]
DOC_FILES.append("docs/DEVICE-COLLECTOR.md")
DOC_FILES += ["docs/AI-INSTALL.md", "docs/STATUS.md"]
COMMON_FILES += ["datasets/timed-packs/manifest-v1.json", "docs/TIMED-PACK-PLAN.md", "docs/TIMED-PACKS.md", "README.md", "AGENTS.md", "SCORE-POLICY.md", "tools/configure_install.py"]
COMMON_FILES += ["packaging/" + name for name in [
    "collector-posix.sh", "Setup-Device-Collector.command", "Start-Device-Collector.command",
    "Setup-Device-Collector-Linux.sh", "Start-Device-Collector-Linux.sh",
    "Setup-Device-Collector-Windows.cmd", "Setup-Device-Collector-Windows.ps1",
    "Start-Device-Collector-Windows.cmd", "Start-Device-Collector-Windows.ps1", "Setup-Code-Grader-Linux.sh",
]]
FORBIDDEN_PARTS = {".git", ".env", ".venv", "node_modules", "data", "evidence", "__pycache__", "target"}
FORBIDDEN_FILES = {"credentials.json", "app.sqlite3", "agent-token.txt", "collector-connection.json", "bind-address.txt", "onboarding.json"}
HOME_MARKERS = [str(Path.home()).encode()]

def distribution_policy():
    policy=json.loads((ROOT/'docs/distribution-allowlist.json').read_text())
    paths=[item['file'] for item in policy['third_party_datasets']]+policy['project_authored_data']
    assert paths and len(paths)==len(set(paths)), 'Empty or duplicate dataset allowlist'
    for relative in paths:
        path=Path(relative)
        assert not path.is_absolute() and len(path.parts)==2 and path.parts[0]=='datasets' and path.suffix=='.json', 'Invalid dataset allowlist path'
    for item in policy['third_party_datasets']:
        assert sha(ROOT/item['file'])==item['sha256'], 'Audited dataset changed: '+item['file']
    return policy,sorted(Path(path).name for path in paths)

def expected_packs():
    result={}
    for name in PACKS:
        pack=json.loads((ROOT/'datasets'/name).read_text())
        tasks=pack['tasks'];ids=pack['sources'].get('quick_ids')
        assert pack['id'] not in result, 'Duplicate packaged evaluation pack ID'
        if ids is not None:
            selected=set(ids); quick=sum(task['id'] in selected for task in tasks)
        else:
            subjects={}
            for task in tasks: subjects[task['subject']]=subjects.get(task['subject'],0)+1
            quick=sum(min(n,5) for n in subjects.values())
        result[pack['id']]={'count':len(tasks),'quick':quick}
    return result

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()

def run(args, cwd=ROOT, env=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True, text=True, capture_output=True).stdout

def copy(src, dest, source=None):
    src = (source or ROOT) / src
    if src.is_symlink() or not src.is_file(): raise ValueError(f"Required regular file missing: {src.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    dest.chmod(0o755 if src.suffix in ('.command', '.sh') or src.name == 'llm-bench' else 0o644)

def tree(src, dest, suffixes=None):
    for p in sorted(src.rglob('*')):
        if p.is_file() and (suffixes is None or p.suffix in suffixes):
            if p.is_symlink() or '__pycache__' in p.parts: continue
            copy(p.relative_to(src), dest / p.relative_to(src), src)

def license_files(package):
    result=[]
    for p in package.rglob('*'):
        if p.is_file() and not p.is_symlink() and p.suffix.lower() in ('', '.txt', '.md', '.rst', '.html', '.spdx', '.license', '.notice') and (p.name.lower().startswith(('license', 'licence', 'unlicense', 'copying', 'notice', 'copyright')) or any(part.lower() in ('licenses', 'licences') for part in p.relative_to(package).parts[:-1])) and p.stat().st_size < 2_000_000:
            result.append(p)
    return sorted(result)

def dependency_notices(stage, include_web=True):
    inventory={'scope':'Locked Rust dependencies, including build-time dependencies.' + (' Locked npm dependencies included; Python is separately installed and inventoried.' if include_web else ' Collector contains no web assets, Python or evaluation data.'), 'rust':[], 'npm':[]}
    meta=json.loads(run(['cargo','metadata','--locked','--offline','--format-version','1','--filter-platform','aarch64-apple-darwin']))
    missing=[]
    for p in meta['packages']:
        if p['name']=='llm-bench' and p['source'] is None: continue
        root=Path(p['manifest_path']).parent; files=license_files(root)
        entry={k:p.get(k) for k in ('name','version','license','repository','source')}; entry['license_files']=[]
        for file in files:
            dest=stage/'THIRD-PARTY-LICENSES'/'rust'/f"{p['name']}-{p['version']}"/file.relative_to(root)
            copy(file.relative_to(root),dest,root);entry['license_files'].append(dest.relative_to(stage).as_posix())
        if not files: missing.append('rust:'+p['name']+'@'+p['version'])
        inventory['rust'].append(entry)
    lock=json.loads((ROOT/'web/package-lock.json').read_text()) if include_web else {'packages':{}}
    for path,p in lock['packages'].items():
        if not path: continue
        root=ROOT/'web'/path
        if not root.exists():
            # Platform-specific optional dependencies are not present or bundled.
            if p.get('optional'): continue
            raise ValueError('Installed npm dependency missing: '+path)
        info=json.loads((root/'package.json').read_text());files=license_files(root)
        name=info.get('name',path.rsplit('node_modules/',1)[-1]);version=info['version']
        assert version==p['version'], 'Installed npm version differs from lock: '+name
        license_origin=None
        parent='esbuild' if name.startswith('@esbuild/') else 'rollup' if name.startswith('@rollup/rollup-') else None
        if not files and parent:
            parent_root=ROOT/'web/node_modules'/parent
            parent_info=json.loads((parent_root/'package.json').read_text())
            assert parent_info['version']==version, 'Native binary and parent package versions differ'
            root=parent_root;files=license_files(root);license_origin=parent+'@'+version
        entry={'name':name,'version':version,'license':info.get('license',p.get('license')),'dev':p.get('dev',False),'license_files':[]}
        for file in files:
            dest=stage/'THIRD-PARTY-LICENSES'/'npm'/f"{name.replace('/','__')}-{version}"/file.relative_to(root)
            copy(file.relative_to(root),dest,root);entry['license_files'].append(dest.relative_to(stage).as_posix())
        if license_origin: entry['license_text_origin']=license_origin+' (same-version upstream package; platform package omits duplicate license text)'
        if not files: missing.append('npm:'+name+'@'+version)
        inventory['npm'].append(entry)
    inventory['license_text_missing']=missing
    if missing: raise ValueError('Dependency license text missing: '+', '.join(missing))
    (stage/'DEPENDENCIES.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
    return inventory

def payload(stage, kind, notice_stage):
    if kind=='collector-macos-arm64':
        copy('target/release/llm-bench',stage/'bin/llm-bench')
        for name in ['Start-Device-Collector.command','Setup-Device-Collector.command','collector-posix.sh']:
            copy('packaging/'+name,stage/name)
        copy('docs/DEVICE-COLLECTOR.md',stage/'docs/DEVICE-COLLECTOR.md')
        (stage/'README.md').write_text('이 실행 번들은 macOS Apple Silicon 수집기 전용입니다. 다른 OS 실행 파일은 포함하지 않습니다.\n\n'+(ROOT/'docs/DEVICE-COLLECTOR.md').read_text())
        copy('docs/rust-toolchain-notices.json',stage/'docs/rust-toolchain-notices.json')
        tree(ROOT/'docs/licenses/rust-toolchain',stage/'docs/licenses/rust-toolchain')
        tree(notice_stage/'THIRD-PARTY-LICENSES',stage/'THIRD-PARTY-LICENSES')
        copy('DEPENDENCIES.json',stage/'DEPENDENCIES.json',notice_stage)
        (stage/'PROJECT-LICENSE-STATUS.txt').write_text('프로젝트 고유 코드의 공개 라이선스는 미확정입니다. 제공자의 베타 이용 안내를 따르며 제3자 원문 고지는 각 조건대로 보존합니다.\n')
        return
    for rel in COMMON_FILES+DOC_FILES:
        copy(rel,stage/rel)
    (stage/'BETA-START.md').write_text('# LLM Bench 시작 안내\n\n[한국어 시작 안내](docs/BETA-START.md) · [AI 설치 안내](docs/AI-INSTALL.md) · [전체 사용법](README.md)\n', encoding='utf-8')
    copy('docs/THIRD-PARTY-NOTICES.md',stage/'THIRD_PARTY_NOTICES.md')
    for name in PACKS: copy('datasets/'+name,stage/'datasets'/name)
    tree(ROOT/'LICENSES',stage/'LICENSES')
    tree(ROOT/'docs/licenses',stage/'docs/licenses')
    tree(ROOT/'scorers/vendor',stage/'scorers/vendor',{'.py'})
    copy('packaging/Start-LLM-Bench.command',stage/'Start-LLM-Bench.command')
    copy('packaging/Setup-Graders.command',stage/'Setup-Graders.command')
    copy('packaging/Install-Python.command',stage/'Install-Python.command')
    copy('packaging/Setup-Code-Grader.command',stage/'Setup-Code-Grader.command')
    tree(notice_stage/'THIRD-PARTY-LICENSES',stage/'THIRD-PARTY-LICENSES')
    copy('DEPENDENCIES.json',stage/'DEPENDENCIES.json',notice_stage)
    (stage/'PROJECT-LICENSE-STATUS.txt').write_text('프로젝트 고유 코드의 공개 라이선스는 아직 확정하지 않았습니다.\n이 번들에 MIT 등 새 라이선스를 임의 부여하지 않습니다.\n베타 제공자의 이용·재배포 안내를 확인하세요. 제3자 코드·데이터는 동봉한 각 원문 라이선스를 따릅니다.\n')
    if kind=='macos-arm64':
        copy('target/release/llm-bench',stage/'bin/llm-bench')
        tree(ROOT/'web/dist',stage/'web/dist',{'.html','.js','.css','.svg','.png','.woff','.woff2'})
    else:
        for rel in SOURCE_FILES: copy(rel,stage/rel)
        tree(ROOT/'src',stage/'src',{'.rs'})
        tree(ROOT/'web/src',stage/'web/src',{'.ts','.tsx','.css','.json'})
        tree(ROOT/'packaging',stage/'packaging',{'.command'})
        copy('packaging/Build-Source.command',stage/'Build-Source.command')
        (stage/'.gitignore').write_text('/data/\n/.venv/\n/target/\n/web/node_modules/\n/web/dist/\n/bin/\n')

def audit(stage):
    files=[]
    for p in sorted(stage.rglob('*')):
        if not p.is_file(): continue
        rel=p.relative_to(stage)
        if set(rel.parts)&FORBIDDEN_PARTS or p.name in FORBIDDEN_FILES or rel.as_posix() in EXCLUDED_DATA_FILES or p.suffix in ('.sqlite3','.db','.pem','.key','.map','.pyc'):
            raise ValueError('Private or excluded file selected: '+str(rel))
        data=p.read_bytes()
        if any(marker and marker in data for marker in HOME_MARKERS): raise ValueError('Private host/path marker in '+str(rel))
        if re.search(rb'https?://[A-Za-z0-9._-]+\.ts\.net|\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)\b',data): raise ValueError('Private service address in '+str(rel))
        if re.search(rb'(?:sk-(?:proj-)?[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)',data): raise ValueError('Credential-shaped value in '+str(rel))
        files.append({'path':rel.as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    return files

def archive(stage, dest):
    with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(stage.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(stage.name+'/'+p.relative_to(stage).as_posix(),date_time=(2026,1,1,0,0,0))
                info.create_system=3;info.external_attr=(stat.S_IFREG | (p.stat().st_mode&0o777))<<16;info.compress_type=zipfile.ZIP_DEFLATED
                z.writestr(info,p.read_bytes())

def verify_archive(path, launcher='Start-LLM-Bench.command'):
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        assert len(names)==len(set(names)), 'Duplicate archive path'
        manifest_name=next(n for n in names if n.endswith('/MANIFEST.json'))
        prefix=manifest_name.rsplit('/',1)[0]+'/'
        manifest=json.loads(z.read(manifest_name))
        assert len(names)==len(manifest['files'])+1
        for item in manifest['files']:
            relative=Path(item['path'])
            assert not relative.is_absolute() and '..' not in relative.parts
            assert hashlib.sha256(z.read(prefix+item['path'])).hexdigest()==item['sha256']
        assert z.getinfo(prefix+launcher).external_attr>>16 & 0o111
    return True

def json_get(url):
    with urllib.request.urlopen(url,timeout=3) as r: return json.load(r)

def smoke(zip_path, report_path):
    with tempfile.TemporaryDirectory(prefix='llm-bench-beta-') as tmp:
        root=Path(tmp)
        with zipfile.ZipFile(zip_path) as z:
            for i in z.infolist():
                rel=Path(i.filename)
                assert not rel.is_absolute() and '..' not in rel.parts
            z.extractall(root)
        app=next(root.iterdir()); binary=app/'bin/llm-bench';binary.chmod(0o755)
        manifest=json.loads((app/'MANIFEST.json').read_text())
        assert all(sha(app/f['path'])==f['sha256'] for f in manifest['files'])
        assert not (app/'data').exists() and not (app/'.venv').exists()
        with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
        env=os.environ.copy()
        env.update({'BENCH_PORT':str(port),'BENCH_DATA_DIR':str(app/'data'),'BENCH_PYTHON':str(root/'no-python-environment'/'bin'/'python')})
        logfile=root/'smoke.log'
        with logfile.open('w') as log:
            process=subprocess.Popen([str(binary)],cwd=app,env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+15
                while True:
                    try: health=json_get(f'http://127.0.0.1:{port}/api/health');break
                    except Exception:
                        if process.poll() is not None or time.monotonic()>deadline: raise RuntimeError('Clean app startup failed: '+logfile.read_text()[-2000:])
                        time.sleep(.15)
                runs=json_get(f'http://127.0.0.1:{port}/api/runs');connections=json_get(f'http://127.0.0.1:{port}/api/connections');packs=json_get(f'http://127.0.0.1:{port}/api/packs')
                assert runs==[] and connections==[]
                expected=expected_packs()
                timed=json.loads((ROOT/'datasets/timed-packs/manifest-v1.json').read_text())['packs']
                for p in timed: expected[p['id']]={'count':len(p['task_ids']),'quick':len(p['task_ids'])}
                ids=sorted(p['id'] for p in packs);assert ids==sorted([*expected,'collection-full-v1'])
                for pack in packs:
                    if pack['id'] in expected:
                        assert pack['count']==expected[pack['id']]['count']
                        assert sum(pack['quick_subjects'].values())==expected[pack['id']]['quick']
                combined=next(p for p in packs if p['id']=='collection-full-v1')
                quality={key:value for key,value in expected.items() if key!='api-experience-v1' and not key.startswith('timed-')}
                assert combined['count']==sum(v['count'] for v in quality.values())
                assert sum(combined['quick_subjects'].values())==combined['sources']['quick_count']==sum(v['quick'] for v in quality.values())
                assert {c['id'] for c in combined['sources']['components']}==set(quality)
                assert not set(combined['sources']['missing_components']) & set(expected)
                assert 'api-experience-v1' not in combined['sources']['missing_components']
                assert not any(task_id.startswith('experience:') for task_id in combined['sources']['quick_ids'])
                assert combined['sources']['complete_collection']==(not combined['sources']['missing_components'])
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=3) as r: html=r.read().decode();assert '<div id="root"></div>' in html
                readiness=json_get(f'http://127.0.0.1:{port}/api/readiness')
                assert all(v['available'] is False for v in readiness['scorers'].values())
                result={'health':health,'runs_empty':True,'connections_empty':True,'pack_ids':ids,'pack_counts':{p['id']:p['count'] for p in packs},'quick_counts':{p['id']:sum(p['quick_subjects'].values()) for p in packs},'missing_components':combined['sources']['missing_components'],'manifest_hashes_verified':True,'frontend_served':True,'missing_python_returns_preparation_error':True,'isolated_data_directory':True,'model_requests':0,'environment':'same Mac, separate extraction and empty data; Python environment explicitly unavailable; not a separate physical Mac','system':platform.system(),'architecture':platform.machine(),'macos':platform.mac_ver()[0]}
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: process.kill();process.wait()
        report_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        return result

def collector_smoke(zip_path, report_path):
    with tempfile.TemporaryDirectory(prefix='bench-collector-bundle-') as tmp:
        root=Path(tmp)
        with zipfile.ZipFile(zip_path) as z:
            for item in z.infolist():
                rel=Path(item.filename)
                assert not rel.is_absolute() and '..' not in rel.parts
            z.extractall(root)
        app=next(root.iterdir());binary=app/'bin/llm-bench';binary.chmod(0o755)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        state=root/'private-state';logfile=root/'collector.log'
        env={k:v for k,v in os.environ.items() if k not in ('BENCH_AGENT_TOKEN','BENCH_AGENT_TOKEN_FILE','BENCH_AGENT_BIND','BENCH_AGENT_OFFLOAD')}
        env.update(BENCH_COLLECTOR_DIR=str(state))
        with logfile.open('w') as log:
            process=subprocess.Popen(['bash',str(app/'Start-Device-Collector.command'),'--bind',f'127.0.0.1:{port}'],cwd=app,env=env,stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+15
                while not (state/'agent-token.txt').exists():
                    if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Collector preparation failed')
                    time.sleep(.05)
                token=(state/'agent-token.txt').read_text().strip()
                def read(path, authorized=True):
                    request=urllib.request.Request(f'http://127.0.0.1:{port}/{path}',headers={'Authorization':'Bearer '+token} if authorized else {})
                    with urllib.request.urlopen(request,timeout=3) as response:return json.load(response)
                while True:
                    try:health=read('health');break
                    except OSError:
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Collector startup failed')
                        time.sleep(.1)
                assert health['read_only'] and health['service']=='bench-agent'
                try:read('metrics',False);raise AssertionError('Unauthenticated metrics accepted')
                except urllib.error.HTTPError as e:assert e.code==401
                while True:
                    metrics=read('metrics')
                    if metrics.get('timestamp'):break
                    if time.monotonic()>deadline:raise AssertionError('Collector sample missing')
                    time.sleep(.15)
                assert metrics['source']=='bench-agent'
                assert token not in logfile.read_text()
                assert token not in (state/'collector-connection.json').read_text()
                assert (state/'agent-token.txt').stat().st_mode&0o777==0o600
                assert not (app/'data').exists() and not (app/'.venv').exists() and not (app/'datasets').exists()
                result={'authenticated_health':True,'unauthenticated_metrics_status':401,'sample_received':True,'private_token_file':True,'secret_not_logged':True,'python_docker_datasets_required':False,'model_requests':0,'scope':'macOS arm64 isolated extracted collector; model and production devices unchanged'}
            finally:
                if process.poll() is None:process.terminate();process.wait(timeout=10)
        report_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

def main():
    global PACKS, EXCLUDED_DATA_FILES
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path);ap.add_argument('--build',action='store_true',help='Rebuild UI and release binary from installed locked dependencies');ap.add_argument('--verify',action='store_true',help='Extract archive and start an isolated local smoke instance; no model requests');ap.add_argument('--collector-only',action='store_true',help='Build the standalone collector without UI, datasets, Python or code graders');args=ap.parse_args()
    if platform.system()!='Darwin' or platform.machine()!='arm64': raise SystemExit('This packager currently verifies only macOS arm64.')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ');out=args.output or ROOT/'data/releases'/stamp
    if out.exists(): raise SystemExit('Output directory already exists; choose a new version directory.')
    if args.build:
        if not args.collector_only:run(['npm','run','build'],ROOT/'web')
        env=os.environ.copy();env['RUSTFLAGS']=env.get('RUSTFLAGS','')+f' --remap-path-prefix={ROOT}=/llm-bench --remap-path-prefix={Path(os.environ.get("CARGO_HOME",str(Path.home()/".cargo")))}=/cargo'
        run(['cargo','build','--release','--locked'],env=env)
    binary=ROOT/'target/release/llm-bench'
    binary_info=run(['file',str(binary)]).split(': ',1)[-1].strip()
    dynamic_libraries=[line.strip().split(' (',1)[0] for line in run(['otool','-L',str(binary)]).splitlines()[1:]]
    if any(not library.startswith(('/System/Library/', '/usr/lib/')) for library in dynamic_libraries): raise SystemExit('Non-system shared library prevents standalone distribution.')
    build_commands=run(['otool','-l',str(binary)])
    minos=re.search(r'\bminos\s+([0-9.]+)',build_commands)
    minimum_macos=minos.group(1) if minos else 'unknown'
    if 'arm64' not in binary_info: raise SystemExit('Release binary is not arm64.')
    toolchain=json.loads((ROOT/'docs/rust-toolchain-notices.json').read_text())
    assert toolchain['rustc']==run(['rustc','--version']).strip(), 'Rust toolchain changed; refresh standard-library notices before distributing'
    for item in toolchain['files']: assert sha(ROOT/item['file'])==item['sha256'], 'Rust toolchain notice changed: '+item['file']
    allow,PACKS=({'excluded_data':[]},[]) if args.collector_only else distribution_policy()
    EXCLUDED_DATA_FILES={p for p in allow['excluded_data'] if '*' not in p}
    assert not {'datasets/'+p for p in PACKS}&EXCLUDED_DATA_FILES, 'Dataset both allowed and excluded'
    out.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='llm-bench-package-') as tmp:
        temp=Path(tmp);notice=temp/'notices';notice.mkdir();deps=dependency_notices(notice,include_web=not args.collector_only)
        artifacts=[]
        for kind in (('collector-macos-arm64',) if args.collector_only else ('macos-arm64','source')):
            stage=temp/f'llm-bench-0.1.0-beta-{kind}';stage.mkdir();payload(stage,kind,notice)
            files=audit(stage)
            manifest={'format':'llm-bench-beta-manifest-v1','created_at':datetime.now(timezone.utc).isoformat(),'version':'0.1.0-beta','kind':kind,'source_license':'not yet assigned; see PROJECT-LICENSE-STATUS.txt','supported_runtime':'macOS Apple Silicon; other platforms unverified','datasets':PACKS,'excluded':['user data/keys/connections/history','evidence','Python environment','model weights',*allow['excluded_data']],'file_count':len(files),'files':files}
            (stage/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
            dest=out/(stage.name+'.zip');archive(stage,dest)
            verify_archive(dest,'Start-Device-Collector.command' if args.collector_only else 'Start-LLM-Bench.command')
            artifacts.append({'file':dest.name,'bytes':dest.stat().st_size,'sha256':sha(dest),'file_count':len(files)+1,'archive_hashes_verified':True,'launcher_executable':True})
            if kind=='macos-arm64' and args.verify: smoke(dest,out/'clean-smoke.json')
            if args.collector_only and args.verify:collector_smoke(dest,out/'collector-smoke.json')
        (out/'SHA256SUMS').write_text(''.join(f"{a['sha256']}  {a['file']}\n" for a in artifacts))
        report={'created_at':datetime.now(timezone.utc).isoformat(),'artifacts':artifacts,'binary':binary_info,'minimum_macos_link_target':minimum_macos,'tested_macos':platform.mac_ver()[0],'dynamic_libraries':dynamic_libraries,'rust_dependencies':len(deps['rust']),'npm_dependencies':len(deps['npm']),'privacy_scan':'passed','license_text_missing':deps['license_text_missing'],'clean_smoke':'passed' if args.verify else 'not run','published':False}
        (out/'release-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'output':str(out),**report},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
