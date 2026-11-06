# 장비 수집기 준비와 연결

장비 수집기는 **모델이 실행되는 장비**에서 CPU·메모리·GPU·온도·전력 등의 읽기 전용 상태를 제공한다. 모델을 시작·종료하거나 장비 설정을 바꾸지 않는다. 코드 채점기와 별개의 선택 기능이다. Rust 실행 파일과 운영체제 기본 명령만 사용하므로 Python·Docker는 필요하지 않다.

## 최초 앱 설정에서 고르는 대상

- **앱이 실행 중인 이 PC**: 모델도 이 PC에서 실행된다. 앱의 로컬 계측을 선택하면 별도 수집기를 실행할 필요가 없다. 이 값은 앱 PC 정보이며 외부 모델 서버 정보가 아니다.
- **외부 서버**: 모델 서버에 해당 OS·아키텍처의 독립 수집기를 복사하고 실행한 뒤 앱의 장비 연결에 등록한다. 앱 PC의 온도·메모리를 서버 상태처럼 표시하지 않는다.

선택은 앱 첫 준비 화면에서 저장한다. 설치 CLI는 같은 질문을 다시 묻거나 기존 선택을 덮어쓰지 않는다. `BENCH_DATA_DIR/onboarding.json`은 다음 선호값만 보관하고 준비 여부는 실제 상태 확인으로 따로 판단한다.

```json
{"schema_version":1,"model_location":null,"code_grading":false,"device_collection":true,"completed":false,"updated_at":null}
```

`model_location`은 `local` 또는 `remote`, `code_grading`·`device_collection`은 설치/사용 선호다. 토큰과 API 키는 여기에 넣지 않는다.

## 준비 → 시작 → 상태 확인

| OS | 준비 | 시작 |
|---|---|---|
| Windows | `Setup-Device-Collector-Windows.cmd` | `Start-Device-Collector-Windows.cmd` |
| macOS | `Setup-Device-Collector.command` | `Start-Device-Collector.command` |
| Linux | `bash Setup-Device-Collector-Linux.sh` | `bash Start-Device-Collector-Linux.sh` |

전체 앱 폴더에서는 위 파일이 `packaging/` 안에 있을 수 있다. 독립 수집기 ZIP에서는 루트에서 실행한다. 준비는 사용자 전용 토큰·연결 파일을 만들며, 시작은 준비가 없으면 먼저 준비한 뒤 `llm-bench agent`를 실행한다. 최초 기본 주소는 `127.0.0.1:18761`이고 이 주소는 같은 장비에서만 접속할 수 있다. 외부 주소나 방화벽을 자동으로 열지 않는다.

외부 모델 서버에서 앱 PC가 접속해야 한다면 사용자가 서버의 실제 내부망/Tailscale IP를 명시한다. 아래 주소는 예시이며 실제 주소로 바꾼다.

```powershell
.\Start-Device-Collector-Windows.cmd -Bind '100.64.0.10:18761'
```

```bash
bash Start-Device-Collector-Linux.sh --bind '100.64.0.10:18761'
./Start-Device-Collector.command --bind '100.64.0.10:18761'
```

해당 IP가 장비에 없으면 시작에 실패한다. `0.0.0.0`·`[::]`는 사용자가 명시한 경우에만 허용하며 연결 파일 URL을 비워 둔다. 앱에는 wildcard 대신 실제 접속할 IP를 넣어야 한다. 방화벽 변경은 별도 운영 판단이며 도구가 광역 허용 규칙을 추가하지 않는다. 수집기 자체 TLS는 없으므로 신뢰하는 내부망·암호화 터널 범위에서 사용한다.

## 토큰과 연결 파일

기본 상태 폴더:

- Windows: `%LOCALAPPDATA%\LLM-Bench\collector`
- macOS: `~/Library/Application Support/LLM-Bench/collector`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/llm-bench/collector`

`BENCH_COLLECTOR_DIR`로 전용 폴더를 지정할 수 있다. 폴더는 Unix700/파일600 또는 Windows 현재 사용자 전용 ACL로 보호한다. 기존 토큰을 임의로 회전하지 않는다.

| 파일 | 용도 |
|---|---|
| `agent-token.txt` | 32바이트 난수의 64자리 hex 토큰. 비밀값이며 콘솔에 출력하지 않는다. |
| `bind-address.txt` | 다음 시작에서 사용할 listen 주소 |
| `collector-connection.json` | bind·metrics URL·health URL·토큰파일 이름. 실제 토큰은 포함하지 않는다. |

앱의 장비 연결에 `url`과 토큰 파일 내용을 민감 입력으로 등록하고 상태 확인을 누른다. 토큰을 일반 채팅·로그·보고서에 붙이지 않는다. 연결 파일 자체는 비밀값을 담지 않지만 서버 주소는 포함하므로 공유 전에 확인한다. 인증을 설정한 수집기의 `/health`와 `/metrics` 모두 `Authorization: Bearer <token>`이 필요하다. 이 토큰은 장비 수집기 전용이며 모델 API 키와 다르다.

시작 터미널의 Control-C로 수집기를 종료한다. 모델 서버·Docker·다른 앱은 종료하지 않는다. 자동 서비스 설치는 제공하지 않는다.

## 코드 채점기와 같은 준비 방식

코드 채점은 OS별 `Setup-Code-Grader` 파일에서 별도로 준비하고 앱에서 상태를 확인한다. 일반 모델 시험과 독립 수집기는 Docker 없이 사용할 수 있다. 현재 코드 채점은 준비된 Docker Linux 환경을 쓰며 Windows AppContainer·Mac App Sandbox는 검증 단계다. OS 네이티브 격리가 구현됐다고 표시하지 않는다.

Linux의 일반 채점 의존성은 Python3.11 이상에서 `python3 tools/prepare_graders.py --data-dir ./data`로 준비하고, 코드 채점만 원하면 기존 Docker 환경에서 `bash packaging/Setup-Code-Grader-Linux.sh`를 실행한다. Docker·가상머신·시스템 Python을 자동 설치하지 않는다.
