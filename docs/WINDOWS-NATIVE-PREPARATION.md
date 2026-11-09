# Windows 네이티브 설치 준비

현재 Windows x86_64 실행 ZIP은 기존 Windows11 PC의 별도 압축해제 폴더·빈 데이터에서 루트 시작기, 화면·API, 기본팩 네 모드와 종료를 검증했다. 기본팩 `2026-11-09.1`은10분41개·1시간160개·4시간536개·8시간1,010개다. 별도 신규 OS와 일반 채점 의존성 신규 설치는 미검증이다. 실행 ZIP은 실제 제공된 파일을 사용하며 GitHub 소스 ZIP과 구분한다.

### 이전 실제 채점·장비 검증 기록

2026-11-06. Windows GNU 실행 파일의 실제 PC 기동, 전체 채점 준비, MATH 정상·오답, CPU·RTX5080 계측을 확인했다. 빠른367문항을 완료했고 요청·채점 환경 오류는0건이었다. 초기에는 성능팩 코드3건의 Markdown 형식 때문에 성능·종합지수가 미산출됐지만, 형식 진단과 유효 성능 응답을 분리한 v3.1 수정 후 저장된 기록으로 성능2,092.8점·종합85.1–91.5점을 자동 산출했다. 지능79.5–88점과 원문·측정값은 보존했다. 당시 시험 종료 후 준비·수집기 스크립트를 적용했고 기존1시험·367응답·2설정·인증 파일 SHA동일을 확인했다. Sol Low 1,000점 기준은 유지한다. 당시 검증은 특정 개인 PC 기준이며 현재 실행 ZIP 검증 범위와 구분한다. 실제 기록은 `evidence/pc-install-20261106/`, 점수 수정 검증은 `evidence/performance-gate-20261106/`에 있다.

## AI 설치 흐름

설치 AI는 [AI 설치 안내서](AI-INSTALL.md)를 먼저 읽고 모델 위치, 장비 수집기 설치, 코드 채점기 설치 여부를 질문한다. 선택한 항목을 준비하고 API·장비 연결과 채점 준비 상태를 확인한다. 앱에서는 같은 질문을 다시 표시하지 않고 홈을 연다. 이후 변경은 연결 관리에서 한다.

시험 기록과 결과는 로컬 기기에 저장되며 개발자 서버로 자동 업로드되지 않는다. 사용자가 연결한 모델 API에는 문제가 전송되고, 외부 채점 API를 사용하면 채점에 필요한 문제·정답·답변도 전송된다.

## 실행 형태

실행 파일 `bin/llm-bench.exe`와 빌드한 `web/dist/`가 갖춰진 앱 폴더에서 시작 스크립트를 열면 최초 의존성을 준비하고 앱·웹을 실행한다. **GitHub 소스 ZIP만 받은 경우에는 아래 소스 빌드가 먼저 필요하다.** 웹에서 모델 API·장비를 연결하고 시험·보고서를 사용한다. Windows `llm-bench.exe`는 PC에서 직접 실행하며 UI는 `http://127.0.0.1:18760`에서 열린다. 코드 채점에만 선택적으로 Docker Desktop의 Linux 컨테이너를 사용한다. 별도 Ubuntu 배포판은 필수 조건이 아니다.

완성된 Windows 실행 파일을 받으면 Rust·Node 빌드는 생략할 수 있다. 이번 PC 실행 파일은 `packaging/Dockerfile.windows-build`의 Rust 1.97.1·MinGW로 Windows GNU 대상에 교차 빌드했다. 확인된 실행 DLL은 Windows 시스템 DLL뿐이며 PC에 Visual Studio Build Tools나 별도 Rust 설치 없이 기동했다. Docker 교차 빌드는 배포 제작 과정이고 일반 앱 실행 요건이 아니다. Mac 실행 파일이나 Mac `.venv`를 Windows에 복사해 쓰지 않는다.

폴더 구성은 소스/화면/평가팩과 `bin/llm-bench.exe`, `packaging/*-Windows.ps1`이다. 최신 소스 ZIP에는 Windows 준비·시작 스크립트를 함께 포함한다. 현재 Windows ZIP에는 대상 Rust 의존성193개의 고지와 빌드 환경 원문고지23개를 포함했다. 새 바이너리를 제작할 때도 대상별 의존성과 고지를 확인한다.

## 설치 및 실행

실행 ZIP은 루트의 `Start-Homelab-Bench-Windows.cmd`, 빌드한 소스 폴더는 `packaging/Start-Homelab-Bench-Windows.cmd`를 더블클릭한다. 두 경로 모두 같은 준비·시작 과정을 사용한다. 준비만 다시 하려면 `packaging/Setup-Graders-Windows.cmd`를 연다. PowerShell을 직접 사용하는 경우 앱 폴더에서 아래 명령을 실행한다. Python 3.11 이상이 있어야 하며 3.12를 포함한 실제 설치 버전으로 의존성과 채점 준비 상태를 검증한다.

```powershell
.\packaging\Start-Homelab-Bench-Windows.ps1
```

첫 시작은 기존 Python을 찾아 `.venv\Scripts\python.exe`와 일반 채점 의존성·NLTK 자료를 준비한다. 버전과 자료가 맞으면 다시 설치하지 않는다. Python 자체가 없다면 `Install-Python-Windows.ps1`이 [공식 설치 페이지](https://www.python.org/downloads/release/python-31410/)를 연다. **Python 설치 화면은 사용자가 직접 완료해야 하는 현재 제약**이다. 설치를 나중에 하려면 안내에서 Enter를 누르면 된다. 준비 실패 시에도 앱은 열리며 내장 시험을 사용할 수 있다. `-SkipSetup`은 준비 단계를 건너뛰고, `-NoBrowser`는 자동 브라우저 열기를 생략한다.

`.cmd` 진입점은 사용자가 직접 연 제공 스크립트를 `-NoProfile -ExecutionPolicy Bypass`로 실행한다. 이 옵션은 해당 PowerShell 프로세스에만 적용하며 `Set-ExecutionPolicy`로 사용자·시스템의 저장 정책을 바꾸지 않는다. Defender·SmartScreen을 끄거나 우회하지 않으며 조직 정책에 막히면 실패 안내를 남긴다. 다운로드 출처와 제공 스크립트를 확인한 뒤 실행한다. 서명된 앱 실행 런처는 후속 과제다.

준비만 다시 하거나 특정 Python을 지정하려면 `.\packaging\Setup-Graders-Windows.ps1 -Python 'C:\실제경로\python.exe'`를 실행한다. Python·Docker·가상머신을 무인 설치하지 않는다.

키와 기록의 기본 위치는 현재 Windows 사용자의 `%LOCALAPPDATA%\LLM-Bench\data`다. 별도 검증 데이터가 필요하면 설치와 시작 모두 같은 `-DataDirectory`를 지정한다. 사용자의 기존 HOME 환경변수는 바꾸지 않는다. `BENCH_PYTHON`·`BENCH_DATA_DIR`·이미지 이름을 이미 명시했다면 그대로 사용한다.

앱이 준비되면 기본 브라우저가 열린다. 연결 관리에서 API·장비를 연결한 뒤 시험과 보고서로 이동한다. 브라우저만 닫아도 앱은 동작한다. 실행 터미널의 Control-C로 종료한다. 자동 시작 서비스 등록이나 기존 모델 프로세스 변경은 하지 않는다.

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

기존 digest 고정 Dockerfile과 실행 이미지 ID 기록을 그대로 쓴다. 생성된 코드를 Windows 호스트 Python에서 실행하는 대체 경로는 없다.

Windows AppContainer·Mac App Sandbox를 이용한 OS 네이티브 코드 채점은 별도 검증 단계이며 아직 지원 완료로 표시하지 않는다. 준비된 코드 채점 환경이 없어도 일반 평가팩을 사용할 수 있다.

## Windows 호환 변경

- Math-Verify 0.9.0은 Windows timeout 구현에서 중첩 함수를 multiprocessing에 넘긴다. Windows spawn에서 이 함수를 pickle할 수 없어 정답 파싱·채점 준비가 실패할 수 있다. Windows에서만 내부 parse/verify 타이머를 끄고 기존 Rust의 별도 Python 프로세스 전체 제한시간을 사용한다. 일반 채점은 45초, 준비 확인은 35초이며 제한 초과는 0점이 아니라 채점 불가다. 비교/추출 함수는 공식 라이브러리 그대로이고 결과에 `timeout_policy`를 기록한다. Mac/POSIX 동작은 바꾸지 않는다.
- Windows Python 입력·출력은 UTF-8로 지정하고 Python 실행 경로는 `.venv\Scripts\python.exe`로 지정한다.
- 새 Windows 로컬 장비 이름은 `이 PC`로 만든다. 기존 저장된 장비 이름은 변경하지 않는다.
- Windows 키 파일은 사용자 프로필 아래에 저장한다. 암호화된 OS 키체인이 아니므로 실제 PC ACL과 다른 사용자 접근 여부를 확인해야 한다. 사용자 지정 공유 폴더를 데이터 경로로 쓰지 않는다.

## 소스에서 직접 빌드할 때

Rust/Cargo와 Node/npm, 선택 Rust 대상에 맞는 C compiler/linker가 이미 있어야 한다. MSVC 대상은 C++ Build Tools/Windows SDK, GNU 대상은 해당 MinGW 도구 구성이 필요하다. 도구 자동 설치는 하지 않는다.

```powershell
powershell -NoProfile -File .\packaging\Build-Source-Windows.ps1
.\packaging\Start-Homelab-Bench-Windows.cmd
```

이 스크립트는 기존 Rust 기본 대상을 빌드한다. 교차 빌드는 배포 담당자가 Linux Rust Docker 컨테이너에서 수행한다. `Dockerfile.windows-build`는 `x86_64-pc-windows-gnu`와 MinGW, `crt-static`을 사용하고 `/work`·Cargo 경로를 치환한다. DLL 의존성을 확인한 후 `target/x86_64-pc-windows-gnu/release/llm-bench.exe`만 앱의 `bin/`에 배치한다. 개인 키·DB를 Docker 빌드 문맥에 넣지 않는다. PC용 파일 허용 목록과 최종 압축 해제 검증은 별도 산출물로 기록한다.

## PC 완료 조건

빈 데이터 기동, 평가팩 개수와 해시, Python UTF-8, MATH 정상·오답, 코드 채점 정상·오답·환경 오류, 연결 확인, RTX5080 장비 정보, 실제 선택 시험 완료를 확인한다. Mac에서 수행한 정적 검사와 호환 옵션 검사는 Windows 실제 검증을 대신하지 않는다. 성능 점수는 기존 API 기준점을 사용하고 PC 결과로 덮어쓰지 않는다. 새 시험은 기본 벤치팩의10분·1시간·4시간·8시간 모드를 사용하며, 선택 과목을 반영한 문항 수를 확인한다. 기본팩에는 LCB 자료가 없으므로 모든 기본팩 문항을 완료해도 지능은 미측정8.333…%를 포함한 가능 범위다. BBH는 별도 정확도이며 LCB 가중치를 대신하지 않는다. 코드팩도 선택하지 않았다면 지능 확인 비중은 최대75%이고 남은 비중을 범위로 표시한다.
