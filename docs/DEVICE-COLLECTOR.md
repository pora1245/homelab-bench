# 장비 수집기 준비와 연결

장비 수집기는 **모델이 실행되는 장비**에서 CPU·메모리·GPU·온도·전력 등의 읽기 전용 상태를 제공하는 선택 기능이다. Python·Docker는 필요하지 않다.

## 설치 AI가 확인하는 모델 위치

- **앱과 같은 PC**: 앱의 내장 수집을 사용한다.
- **외부 서버**: 모델 서버에 해당 OS·아키텍처의 수집기를 준비하고 실행한 뒤 앱의 장비 연결에 등록한다.

설치 AI는 [AI 설치 안내서](AI-INSTALL.md)에 따라 모델 위치와 장비 수집 여부를 확인한다. 설치 후에는 **연결 관리**에서 장비를 추가하거나 상태를 확인한다.

## 준비 → 시작 → 상태 확인

| OS | 준비 | 시작 |
|---|---|---|
| Windows | `Setup-Device-Collector-Windows.cmd` | `Start-Device-Collector-Windows.cmd` |
| macOS | `Setup-Device-Collector.command` | `Start-Device-Collector.command` |
| Linux | `bash Setup-Device-Collector-Linux.sh` | `bash Start-Device-Collector-Linux.sh` |

GitHub 소스에서는 대상 OS용 실행 파일을 빌드해 `bin/`에 배치한 뒤 `packaging/`의 파일을 사용한다. 준비는 사용자 전용 토큰·연결 파일을 만들고, 시작은 저장된 설정으로 수집기를 실행한다. 최초 주소는 같은 장비에서만 접속할 수 있는 `127.0.0.1:18761`이다.

외부 모델 서버에서 앱 PC가 접속하려면 서버의 실제 내부망/Tailscale IP를 지정한다. 아래 명령은 저장소 루트 기준이며, 예시 주소를 실제 주소로 바꾼다.

```powershell
.\packaging\Start-Device-Collector-Windows.cmd -Bind '100.64.0.10:18761'
```

```bash
bash packaging/Start-Device-Collector-Linux.sh --bind '100.64.0.10:18761'
./packaging/Start-Device-Collector.command --bind '100.64.0.10:18761'
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

시작 터미널의 Control-C로 수집기를 종료한다. 자동 서비스 설치는 제공하지 않는다.
