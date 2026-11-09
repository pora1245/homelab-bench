# Homelab Bench 시작 안내

모델 API를 시험하고 결과를 보는 로컬 앱입니다. 시험 기록과 결과는 설치한 기기에 저장되며 개발자 서버로 자동 업로드되지 않습니다. 문제는 사용자가 연결한 모델 API로 전송되고, 채점용 외부 API를 선택하면 문제·정답·답변도 해당 제공업체로 전송됩니다. 비용·토큰 사용량은 사용한 서비스 기준을 따릅니다.

**AI에게 설치를 맡기려면 [AI 설치 안내서](AI-INSTALL.md)를 읽고 진행하라고 요청하세요.** AI가 모델 실행 위치, 장비 수집기, 코드 채점기 선택을 질문하고 필요한 설치·연결·상태 확인을 수행합니다. 설치 후 설정은 **연결 관리**에서 변경합니다.

## 1. 설치와 앱 시작

GitHub의 **Code → Download ZIP**으로 최신 소스를 받거나 저장소를 복제합니다. 소스에는 실행 파일이 없으므로 Rust/Cargo·Node/npm과 대상 OS에 맞는 C/C++ 빌드 도구가 필요합니다. [README의 소스 빌드](../README.md#소스에서-빌드하기)를 따라 빌드한 뒤 아래 시작 파일을 실행하세요. 명령은 저장소 루트 기준입니다.

| 환경 | 시작 |
|---|---|
| Apple Silicon Mac | `zsh packaging/Start-Homelab-Bench.command` |
| Windows x86_64 | `.\packaging\Start-Homelab-Bench-Windows.cmd` |

앱 시작·화면 확인은 Apple Silicon Mac(macOS 26.5.2)과 Windows 11 x86_64에서 수행했습니다. 별도 새 OS·일반 채점 의존성 신규 설치, 이전 macOS, Intel Mac·Linux 전체 앱, macOS 서명·공증은 미검증입니다. Windows 준비는 [Windows 안내](WINDOWS-NATIVE-PREPARATION.md)를 참고하세요.

시작 스크립트가 일반 채점 의존성을 준비한 뒤 앱과 브라우저를 엽니다. 브라우저가 열리지 않으면 `http://127.0.0.1:18760`에 접속하세요. **연결 관리**에서 모델 API 주소·모델 ID·키와 시험 장비를 연결하고, 서버에 맞는 Chat Completions 또는 Responses API 방식을 선택합니다.

macOS가 실행을 차단하면 받은 출처를 확인한 뒤 시스템 설정에서 실행 허용 여부를 결정하세요. 보안 설정을 일괄 해제하지 마세요.

브라우저만 닫으면 시험은 계속됩니다. 시험을 일시정지·중단하거나 완료한 뒤 시작 터미널에서 **Ctrl+C**를 눌러 앱을 종료하세요. 포트가 이미 사용 중이면 Mac은 `BENCH_PORT=18762 zsh packaging/Start-Homelab-Bench.command`, Windows는 `.\packaging\Start-Homelab-Bench-Windows.cmd -Port 18762`로 바꿔 실행합니다.

## 2. 채점 환경 준비

코드 채점을 선택하지 않으면 기본 시험 과목에서 제외합니다. 나중에 **연결 관리**에서 준비한 뒤 새 시험에 추가할 수 있습니다.

모델이 앱과 같은 PC에 있으면 내장 장비 수집을 사용하고, 외부 서버에 있으면 그 서버에 수집기를 설치합니다. 상세 설치와 인증 연결은 [장비 수집기 안내](DEVICE-COLLECTOR.md)를 참고하세요.

채점 준비에 실패해도 내장 채점 과목부터 사용할 수 있습니다. 준비를 건너뛰려면 Mac은 `BENCH_SKIP_SETUP=1 zsh packaging/Start-Homelab-Bench.command`, Windows는 `.\packaging\Start-Homelab-Bench-Windows.cmd -SkipSetup`을 사용합니다.

- **GSM8K·MMLU-Pro·BBH**: 내장 채점기를 사용하므로 Python·Docker 없이 시작할 수 있습니다.
- **IFEval·MATH-500**: Python 3.11 이상과 지정 의존성이 필요하며 IFEval에는 NLTK 자료도 필요합니다. Python 3.11을 권장합니다.
- **HumanEval·MBPP**: Python 채점 환경과 실행 중인 Docker Desktop 또는 Colima가 필요합니다. 모델이 생성한 코드를 호스트 Python으로 직접 실행하는 대체 경로는 없습니다.

일반 채점 준비는 Mac의 `packaging/Setup-Graders.command`, Windows의 `packaging/Setup-Graders-Windows.cmd`를 사용합니다. 기존 Python 3.11 이상을 찾고 `.venv`에 필요한 의존성을 준비합니다. Python이 없으면 공식 설치 페이지를 안내하며, 설치 화면은 사용자가 진행합니다. Mac에서 Python 명령을 직접 지정하려면 다음처럼 실행하세요.

```bash
BENCH_SETUP_PYTHON=python3 zsh packaging/Setup-Graders.command
```

**Docker는 코드 시험에만 필요합니다.** Docker Linux 실행 환경을 먼저 준비하고 Mac의 `packaging/Setup-Code-Grader.command` 또는 Windows의 `packaging/Setup-Code-Grader-Windows.cmd`로 코드 채점 이미지를 만듭니다. 준비 도구는 Docker·가상머신을 자동 설치하지 않습니다. 이미지의 수동 준비 명령은 다음과 같습니다.

```bash
docker build -t llm-bench-code:py311 - < scorers/Dockerfile
```

의존성 설치에는 인터넷 연결이 필요합니다. 설치 후 앱의 새 시험에서 **상태 다시 확인 → 채점 준비 완료**를 확인하세요. 준비 필요·확인 실패는 표시된 원인에 따라 해결합니다. 코드 채점은 Docker Linux 환경을 사용하며 Windows AppContainer·Mac App Sandbox는 미검증입니다.

## 3. 시험과 점수

**새 시험 → 저장한 모델 → 기본 벤치팩 → 시험 시간** 순서로 선택합니다. 기본팩 `2026-11-09.1`은 아래 네 모드로 구성됩니다.

| 모드 | 문항 | 용도 |
|---|---:|---|
| 10분 | 41 | 연결과 기본 능력 확인 |
| 1시간 | 160 | 주요 능력 비교 |
| 4시간 | 536 | 분야별 상세 확인 |
| 8시간 | 1,010 | 기본팩 전체 평가 |

작은 모드의 문항은 큰 모드에도 모두 포함됩니다. 수학·지식·복합 논리·지시 이행·코딩을 다루며, 원본7종의 보관 자료21,567문항에서 고정 선별했습니다. [기본팩 구성·실측](BASIC-PACK.md)과 [원본 자료·채점 방식](../datasets/README.md)을 확인하세요. 실측 기준은 Qwen·RTX3060·단일 요청이며, 다른 모델·추론·동시 요청 설정이나 과목 제외 시 완료 시간이 달라집니다.

진행 중 문제와 답안, TTFT·Decode·Throughput과 문항별 판정을 보고, 완료 후 홈의 지능·성능·종합 점수와 보고서를 확인합니다. 보고서 양식을 고른 뒤 이미지나 PDF로 저장할 수 있습니다. 성능은 품질 문제를 푸는 동안 측정한 **단일 요청 TTFT·Decode 기본점수와 검증된 동시 처리 가산점**으로 계산합니다. 지능·종합은100점 만점이고 성능은 상한이 없습니다. 산식과 기준은 [점수 정책](../SCORE-POLICY.md)을 따릅니다.

LiveCodeBench는 자료 재배포 조건 검토가 남아 기본팩에 포함하지 않습니다. BBH는 별도 복합 논리 정확도로 표시하고 다른 미평가 영역의 가중치를 대신하지 않습니다. 과목을 일부 제외하거나 채점하지 못한 영역은 미평가로 남으며, 출력 잘림·환경 실패와 정오답을 구분합니다. 같은 팩 버전·모드·과목·추론 설정·출력 한도끼리 비교하세요. 원본 전체 점수와 이 발췌판의 점수는 구분합니다.

TTFT에는 통신·서비스 대기·추론이 포함됩니다. Prefill은 서버가 실제 제공한 경우 표시하며 TTFT에서 대신 계산하지 않습니다.

## 4. 자료 추가

데이터팩을 직접 추가하려면 앱의 평가팩 추가에서 `schemas/pack.schema.json` 형식의 JSON을 선택합니다. 사용자 평가팩·문항 ID에는 `custom:`처럼 고유 접두사를 사용합니다. 공식 평가팩의 예약 ID를 재사용해 공식 점수로 보이게 만드는 등록은 차단됩니다. 추가 자료의 사용·재배포 권리를 확인해야 합니다.

기본팩과 필요한 원본 자료는 저장소에 포함돼 있어 추가 다운로드나 팩 재생성이 필요하지 않습니다. 출처와 채점 방식은 [원본 자료 안내](../datasets/README.md)를 참고하세요.

## 5. 기록과 공유

- Mac 기본 데이터 폴더: 앱 폴더 아래 `data/`
- Windows 시작 스크립트 기본 데이터 폴더: `%LOCALAPPDATA%\LLM-Bench\data`
- `BENCH_DATA_DIR` 또는 Windows의 `-DataDirectory`를 지정했다면 그 경로를 사용합니다.
- 시험 기록·연결·장비: 데이터 폴더의 `app.sqlite3`
- API 키: 같은 폴더의 `credentials.json` 별도 파일. Unix 권한을 제한하지만 OS 키체인은 아닙니다.
- NLTK 자료: 같은 폴더의 `nltk_data/`
- 업데이트: 실행기를 종료하고 실제 사용 중인 데이터 폴더 전체를 백업한 뒤 같은 기록 경로를 사용합니다. 실행 중 DB 파일을 단순 복사하지 않습니다.
- 재공유: 사용한 앱 폴더에는 키·주소·기록이 포함될 수 있으므로 그대로 공유하지 마세요.
- 원시 JSON 결과에는 프롬프트·출력·메모·연결 주소가 들어갈 수 있습니다. 공유 전 직접 검토하세요.

앱 코드의 재배포 조건은 [라이선스 상태](../PROJECT-LICENSE-STATUS.txt), 데이터·채점기·의존성의 조건은 [제3자 고지](THIRD-PARTY-NOTICES.md)에서 확인하세요.
