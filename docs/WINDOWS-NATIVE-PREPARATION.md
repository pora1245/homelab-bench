# Windows 설치 안내

Windows x86_64에 GitHub 최신 소스로 설치하는 안내다. 앱 시작·화면·종료는 Windows 11에서 확인했다. 별도 신규 OS와 일반 채점 의존성 신규 설치는 미검증이다.

## AI 설치 흐름

설치 AI는 [AI 설치 안내서](AI-INSTALL.md)를 먼저 읽고 모델 위치, 장비 수집기 설치, 코드 채점기 설치 여부를 질문한다. 선택한 항목을 준비하고 API·장비 연결과 채점 준비 상태를 확인한다. 이후 변경은 **연결 관리**에서 한다.

시험 기록과 결과는 로컬 기기에 저장되며 개발자 서버로 자동 업로드되지 않는다. 사용자가 연결한 모델 API에는 문제가 전송되고, 외부 채점 API를 사용하면 채점에 필요한 문제·정답·답변도 전송된다.

## 소스 빌드

GitHub의 **Code → Download ZIP**은 실행 파일이 없는 소스다. Rust/Cargo와 Node/npm, 선택 Rust 대상에 맞는 C compiler/linker를 준비한다. MSVC 대상은 C++ Build Tools/Windows SDK, GNU 대상은 해당 MinGW 도구 구성이 필요하다.

저장소 루트에서 실행한다.

```powershell
powershell -NoProfile -File .\packaging\Build-Source-Windows.ps1
.\packaging\Start-Homelab-Bench-Windows.cmd
```

빌드 스크립트는 설치된 Rust 기본 대상을 사용해 `bin/llm-bench.exe`와 `web/dist/`를 준비한다. 앱은 Windows에서 직접 실행하고, 코드 채점에만 Docker Linux 환경을 사용한다. 별도 Ubuntu 배포판은 필수 조건이 아니다.

## 설치 및 실행

빌드 후 `packaging/Start-Homelab-Bench-Windows.cmd`를 더블클릭한다. 준비만 다시 하려면 `packaging/Setup-Graders-Windows.cmd`를 연다. PowerShell을 직접 사용하는 경우 저장소 루트에서 아래 명령을 실행한다.

```powershell
.\packaging\Start-Homelab-Bench-Windows.ps1
```

첫 시작은 Python 3.11 이상을 찾아 `.venv\Scripts\python.exe`와 일반 채점 의존성·NLTK 자료를 준비한다. Python 3.12를 포함해 실제 설치 버전에서 채점 준비 상태를 확인한다. Python이 없으면 공식 설치 페이지를 열며, 설치 화면은 사용자가 진행한다. 설치를 미루려면 안내에서 Enter를 누른다. 준비 실패 시에도 앱은 열리며 GSM8K·MMLU-Pro·BBH는 내장 채점기로 사용할 수 있다. `-SkipSetup`은 준비를 건너뛰고, `-NoBrowser`는 자동 브라우저 열기를 생략한다.

`.cmd`는 제공 스크립트를 `-NoProfile -ExecutionPolicy Bypass`로 실행한다. 해당 PowerShell 프로세스에만 적용되며 사용자·시스템의 저장 정책은 바꾸지 않는다. 다운로드 출처와 스크립트를 확인한 뒤 실행하고, 조직 정책에 막히면 관리자에게 확인한다. Defender·SmartScreen을 끄거나 우회하지 않는다. 서명된 앱 실행 런처는 아직 제공하지 않는다.

준비만 다시 하거나 특정 Python을 지정하려면 `.\packaging\Setup-Graders-Windows.ps1 -Python 'C:\실제경로\python.exe'`를 실행한다. Python·Docker·가상머신을 무인 설치하지 않는다.

키와 기록의 기본 위치는 현재 Windows 사용자의 `%LOCALAPPDATA%\LLM-Bench\data`다. 다른 위치를 쓰려면 준비와 시작 모두 같은 `-DataDirectory`를 지정한다. `BENCH_PYTHON`·`BENCH_DATA_DIR`·이미지 이름을 이미 지정했다면 유지한다.

앱이 준비되면 브라우저의 `http://127.0.0.1:18760`이 열린다. **연결 관리**에서 API·장비를 연결한다. 모델이 같은 PC에서 실행되면 내장 수집을 사용하고, 외부 서버이면 [그 서버에 수집기](DEVICE-COLLECTOR.md)를 준비한다. 포트를 바꾸려면 시작 명령에 `-Port 18762`를 붙인다.

브라우저만 닫아도 시험은 계속된다. 시험을 일시정지·중단하거나 완료한 뒤 시작 터미널의 **Ctrl+C**로 앱을 종료한다. 자동 시작 서비스는 등록하지 않는다.

## 코드 채점은 별도 선택 준비

일반 수학·지식·추론·지시 이행·성능 시험은 Docker 없이 진행할 수 있다. 코드 시험을 원하고 기존 Docker Desktop이 Linux containers 모드로 실행 중이면 `.\packaging\Setup-Code-Grader-Windows.ps1`을 실행한다. `scorers/Dockerfile` 하나만 담은 임시 폴더를 빌드 문맥으로 사용하며 앱 폴더 전체나 개인 파일은 넘기지 않는다. 아래는 동일한 수동 준비 과정이다.

```powershell
$BenchBuildDir = Join-Path ([IO.Path]::GetTempPath()) ('llm-bench-code-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $BenchBuildDir
try {
    Copy-Item '.\scorers\Dockerfile' (Join-Path $BenchBuildDir 'Dockerfile')
    docker build -t llm-bench-code:py311 $BenchBuildDir
    if ($LASTEXITCODE -ne 0) { throw 'Docker build failed' }
} finally { Remove-Item -LiteralPath $BenchBuildDir -Recurse -Force }
```

생성된 코드는 Docker Linux 환경에서 실행하며 Windows 호스트 Python에서 직접 실행하지 않는다.

Windows AppContainer를 이용한 코드 채점은 미검증이다. 코드 채점 환경이 없으면 코드 외 과목을 선택해 시험할 수 있다.

## Windows 채점·저장 조건

- Math-Verify 0.9.0은 Windows의 프로세스 실행 방식과 내부 timeout이 호환되지 않아 내부 타이머 대신 채점 Python 프로세스 전체에 제한시간을 적용한다. 일반 채점은 45초, 준비 확인은 35초이며 제한 초과는 **채점 불가**로 표시한다. 정답 비교·추출은 공식 라이브러리를 사용하고 결과에 `timeout_policy`를 기록한다.
- Windows Python 입력·출력은 UTF-8로 지정하고 Python 실행 경로는 `.venv\Scripts\python.exe`로 지정한다.
- 내장 장비 수집은 **이 PC**를 선택한다. 이전에 저장한 장비는 기존 이름을 사용한다.
- Windows 키 파일은 사용자 프로필 아래에 저장한다. 암호화된 OS 키체인이 아니므로 실제 PC ACL과 다른 사용자 접근 여부를 확인해야 한다. 사용자 지정 공유 폴더를 데이터 경로로 쓰지 않는다.

## 연결 확인과 첫 시험

홈 접근, 모델 API 연결, 선택한 장비의 최신 상태, 선택 과목의 **채점 준비 완료**를 확인한다. 이후 **새 시험 → 기본 벤치팩 → 10분·1시간·4시간·8시간**에서 모드를 고른다. 기본팩 `2026-11-09.1`은 전체 과목 기준 41·160·536·1,010문항이며 과목을 제외하면 문항 수가 줄어든다.

기본팩에는 LCB 자료가 없으므로 모든 기본팩 문항을 완료해도 지능은 미측정 8.333…%를 포함한 가능 범위다. BBH는 별도 정확도이며 LCB 가중치를 대신하지 않는다. 코드 과목도 선택하지 않았다면 지능 확인 비중은 최대 75%이고 남은 비중을 범위로 표시한다. 점수의 기준과 산식은 [점수 정책](../SCORE-POLICY.md)을 따른다.
