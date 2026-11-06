# 실행 계약 · 연결 저장 및 전체 평가팩

서버 기본 주소는 `http://127.0.0.1:18760`. 로컬 브라우저용이며 다른 Origin의 요청을 거부한다. UI와 다른 하네스 모두 같은 REST 계약으로 시험을 실행할 수 있다. 일회성 키는 `api_key`·`judge_key`로 보내거나 저장한 연결 ID를 사용한다. 키는 실행 기록과 분리 보관한다.

## 새 시험

`POST /api/runs`

```json
{
  "api_key": "",
  "judge_key": "",
  "config": {
    "name": "시험 이름",
    "base_url": "http://127.0.0.1:8000/v1",
    "model": "model-id",
    "pack_id": "collection-full-v1",
    "profile": "quick",
    "subjects": [],
    "temperature": 0,
    "max_tokens": 4096,
    "concurrency": 1,
    "timeout_s": 600,
    "reasoning_effort": "",
    "telemetry_url": "",
    "note": "",
    "judge": null
  }
}
```

응답은 `{"id":"UUID"}`. `GET /api/runs/{id}`로 결과를 읽는다. `GET /api/events`는 초기 `ready`와 변경된 실행 ID를 SSE로 보낸다. 이벤트를 받은 UI는 최신 상태를 다시 읽는다. 이벤트 연결이 끊겨도 실행과 SQLite 기록은 유지한다.

- `quick`: 평가팩의 `sources.quick_ids`에 고정된 문항. 가져온 사용자팩에 ID가 없으면 과목당 첫 5문항.
- `full`: 선택 과목의 평가 구간 전체
- `standard`: 이전 실행 재현을 위한 호환 값. 새 UI에는 표시하지 않는다.
- `subjects`: 빈 배열이면 전체 과목
- 실제 요청의 출력 한도: 문항 한도와 실행 한도 중 작은 값
- 지원 시험 API: Chat Completions SSE 또는 일반 JSON 응답
- `judge`: `{"base_url":"...","model":"...","max_tokens":2048}`

## API 목록

| 경로 | 용도 |
|---|---|
| `GET /api/health` | 실행기 버전·응답 확인 |
| `GET/POST /api/setup` | AI 설치에서 확인한 선택 조회·저장. 실제 설치/시험은 시작하지 않음 |
| `POST /api/check` | `base_url`, `api_key`로 모델 목록 연결 확인 |
| `GET/POST /api/packs` | 평가팩 목록 / 새 ID·버전 추가 |
| `GET /api/runs` | 실행 이력과 요약 |
| `POST /api/runs/{id}/pause` | 현재 문항 종료 후 일시정지 |
| `POST /api/runs/{id}/cancel` | 현재 요청 중단 |
| `POST /api/runs/{id}/resume` | 대기 문항 재개 |
| `POST /api/runs/{id}/retry` | 요청 오류 문항만 다시 실행 |
| `POST /api/runs/{id}/rescore` | 저장 응답 재채점·직전 점수 보존 |
| `GET /api/export/{id}` | 원시 응답 포함 전체 JSON |
| `POST /api/import` | 내보낸 실행 레코드 가져오기·새 UUID 부여 |
| `POST /api/artifacts` | PNG/SVG 보고서 저장 |
| `GET /api/artifacts/{UUID.확장자}` | 저장 보고서 다운로드 |

제어 POST의 본문은 `{}` 또는 재입력할 `api_key`·`judge_key` 객체다. 실행 이력 가져오기는 `provenance=imported_record`로 표시하고 대상 모델을 자동 호출하지 않는다. 데이터베이스는 하나의 시험만 동시에 실행하며, 시험 안에서 지정한 동시 요청 수를 사용한다.

## 기록 구조

실행에는 `config`, `pack_version`, `protocol_version`, `suite_hash`, `provenance`, `items`, `telemetry`, `status`를 저장한다. 문항에는 입력·정답·채점기·메타데이터와 `attempts`를 보존한다. 시도마다 시작/완료 시각, 출력·추론 내용, 종료 이유, 오류, 원시 API 프레임, 계측값, 채점값·근거·버전을 저장한다. 재시도는 기존 시도를 덮어쓰지 않는다. 요약은 문항별 마지막 시도를 사용한다.

완료되지 않은 문항의 정답·채점 메타데이터는 조회 화면에서 숨긴다. 시험 대상 API에는 `prompt`만 보내며 정답·채점 메타데이터를 포함하지 않는다. 선택한 채점 API에는 평가에 필요한 정답과 rubric을 전달한다.

`status=completed`는 모든 문항의 요청 처리가 끝났음을 뜻한다. 별도 `errors`, `score_errors`, `truncated`로 API 실패·미채점·출력 잘림을 확인한다. 재시작 시 진행 중 상태는 `interrupted`로 바뀌며 진행 중이던 시도는 오류 사유를 보존한다.

## 연결 프로필

`GET/POST /api/connections`와 `POST /api/connections/{id}/{check|default|delete}`.

등록/수정 본문:

```json
{"name":"서버 모델","kind":"target","base_url":"http://localhost:8000/v1","model":"model-id","is_default":true,"api_key":"","defaults":{"temperature":0,"max_tokens":8192,"concurrency":1,"timeout_s":600,"reasoning_effort":""}}
```

`kind`는 `target` 또는 `judge`. 수정 시 `id`를 보낸다. `api_key` 생략은 기존 키 유지, 빈 문자열은 삭제다. 조회 응답에는 `has_key`만 포함한다. 각 종류별 기본 연결은 하나다. `check`는 저장된 키로 모델 목록을 조회한다.

새 시험 최상위에 `connection_id`, `judge_connection_id`, `device_id`를 보내면 서버가 저장된 연결 주소/모델/키를 적용한다. 실행 조건은 `config`에 명시한다. `config`의 같은 ID 필드도 지원한다. 연결 정보는 실행 시작 때 고정한다. 선택 ID는 생략/빈 문자열/null을 모두 허용하며, 시험 이름을 비우면 모델명·시각으로 만든다. UI는 시작 전에 저장한 연결과 모델 ID를 확인하고 대화창 안에 오류를 표시한다. 재시작 후 연결 주소/모델이 바뀌면 키 자동 복원을 거부한다. 가져온 실행은 연결 ID를 제거해 임의 파일이 저장된 키를 사용할 수 없게 한다.

연결의 `device_id`는 명시적으로 지정한 모델 실행 장비다. 새 시험의 최상위 `device_id`를 생략하면 config의 ID, 연결 프로필의 ID 순으로 적용한다. 최상위에 `null` 또는 빈 문자열을 명시하면 장비 수집을 끈다. localhost 여부나 기본 장비만으로 모델 위치를 추측하지 않는다. `execution_info`는 engine/engine_version/model_revision/quantization/context_length/parallelism/speculative/cache/offload/provenance 문자열로 구성되며 실행 config에 복사한다. 비어 있는 값은 미기록이다. 서버가 광고한 reasoning.options의 선택값은 config.reasoning_parameters로 고정하고 provider가 허용한 reasoning_effort/chat_template_kwargs.enable_thinking·reasoning_effort만 요청에 매핑한다. 문제·정답·모델·온도·토큰 상한을 추가 옵션으로 덮어쓸 수 없다.

## 장비

`GET/POST /api/devices`, `POST /api/devices/{id}/{check|default|delete}`, `GET /api/devices/{id}/sample`.

```json
{"name":"GPU 서버","mode":"ssh","host":"saved-ssh-alias","url":"","is_default":false,"gpu_indices":[0],"include_offload":true}
```

`mode`는 `local`/`http`/`ssh`. HTTP는 `url`, SSH는 `host`를 사용한다. check/sample 응답은 `{ok,status,data,checked_at,age_ms,error}`이며 status는 connected/partial/stale/unavailable이다. 선택 GPU 일부가 누락되면 partial이며 관측된 나머지 값은 보존한다. 원시 data에 timestamp/CPU/RAM/gpus가 있다. SSH는 기존 인증과 고정된 Linux 읽기 명령만 사용한다.

`local`은 브라우저를 연 장비가 아니라 **벤치 실행기가 설치된 장비**다. HTTP 수집기는 모델 서버에서 별도 실행한다. 저장 시 `api_key`로 수집기 Bearer 토큰을 지정할 수 있으며 생략은 유지, 빈 문자열은 삭제다. 조회에는 `has_key`만 반환한다. 키는 credentials.json의 `device:<id>`에만 저장하며 실행 DB·내보내기에 포함하지 않는다. 수집기 URL/방식 변경은 기존 키를 제거하고 redirect는 따르지 않는다. 수집 실패를 다른 로컬 장비 값으로 대체하지 않는다.

별도 실행: `llm-bench agent`. `BENCH_AGENT_BIND` 기본값은 `127.0.0.1:18761`. 외부 IP bind에는 `BENCH_AGENT_TOKEN_FILE` 또는 `BENCH_AGENT_TOKEN` 중 하나가 필수다. 토큰 설정 시 `/health`·`/metrics`는 Bearer 인증이 필요하다. 기본 앱·장비 수집기·코드 채점기는 서로 다른 역할이며 수집기에 Python·Docker가 필요하지 않다. 배포 실행 파일은 `docs/DEVICE-COLLECTOR.md`를 따른다.

## AI 설치 선택 저장

앱은 처음 사용 준비 대화창 없이 홈을 연다. AI 설치 절차는 `docs/AI-INSTALL.md`를 따른다. AI가 사용자에게 모델 위치·장비 수집·코드 채점 사용 여부를 확인한 뒤 `tools/configure_install.py` 또는 아래 API로 저장한다. 연결 추가·변경과 구성 요소 상태 확인은 앱의 연결 관리에서도 할 수 있다.

`GET /api/setup`은 `preferences`와 벤치 실행기 `platform`을 반환한다. POST는 `{schema_version:1,model_location:"local"|"remote",code_grading:boolean,device_collection:boolean,completed:boolean}` 선호만 저장한다. `completed:true`에는 모델 위치가 필수이며 성공 시 `updated_at`을 기록한다. 이 선택은 준비 완료 판정이 아니며 실제 준비 상태를 따로 확인한다. 기존 모델·장비 연결은 덮어쓰지 않는다.

`gpu_indices`를 비우면 전체 GPU 관측이며 모델이 모두 사용했다고 판단하지 않는다. 선택 번호가 있으면 해당 GPU만 data.gpus에 포함한다. CPU/RAM/swap은 장비 전체 범위다. gpu_catalog는 로컬 선택용 목록이며 보고서에는 gpus만 사용한다.

GPU driver/PCIe 협상/클럭/전력 제한·전력/온도/사용률/VRAM/제한 상태와 CPU 모델/코어/RAM/swap을 수집한다. 미지원 값은 null+unavailable 사유다. 알려지지 않은 클럭 제한 비트는 정상으로 단정하지 않는다. include_offload가 true일 때만 NUMA/스토리지 모델·매체·용량·읽기속도를 추가한다(장비 전체). 장치경로/UUID/serial/host/IP는 공개 sample 화이트리스트에서 제외한다. 독립 agent도 같은 수집기를 사용하며 BENCH_AGENT_OFFLOAD=1로 추가 수집하고 7초 제한 후 다음 주기에 복구한다.

## 화면 조회와 채점 준비

- `GET /api/runs/{id}?view=compact`: 목록·점수·계측 요약. 질문·답변 원문과 raw는 제외한다.
- `GET /api/runs/{id}/items/{index}`: 0부터 시작하는 선택 문항의 상세. 미완료 정답은 비공개, raw는 내보내기에서 확인한다.
- `GET /api/readiness`: IFEval/Math-Verify 및 코드 채점 이미지의 준비 상태. 미준비는 0점으로 처리하지 않는다.
- `GET /api/readiness?scorers=math,ifeval`: 선택한 채점기만 확인. 지원하지 않는 이름은 400, 빈 목록은 외부 채점 검사를 생략한다. 코드 과목을 선택하지 않은 시험은 Docker 준비 상태로 막지 않는다.
- `GET /api/export/{id}`: 모든 원문과 원시 응답을 포함한다.

보고서 화면의 SVG가 내보내기의 정본이다. 지능·성능·종합(+문항 상세)을 선택하며 종합은 결과·속도·장비 실측·조건을 여러 페이지로 표시한다. PNG/SVG/HTML은 `/api/artifacts`로 파일을 보존하고 다운로드 링크를 제공한다(attachment/nosniff). HTML/PDF는 같은 전체 SVG 페이지를 조합한다. 원본 JSON은 API 주소/내부경로/원시응답을 포함할 수 있는 개인 보관용 자료이며 공유용 이미지 보고서와 구분한다. 과거 호환 report/compare 경로는 기존 클라이언트용으로 남지만 제품 UI에서는 사용하지 않는다.

생성 중 TTFT는 `ttft_source=client_stream`과 함께 전달한다. 비스트리밍·출력 없음 등은 `ttft_reason`으로 설명한다. 문항 상태 `grading`은 모델 답변을 저장하고 채점 중임을 뜻하며 재시작 후 채점만 재개한다. SQLite는 runs(메타데이터)/run_items(문항)로 분리하고 진행 중 변경된 문항을 5초 간격으로 체크포인트한다.

## 성능 출력 검증 v2

입력 프로토콜은 `api-experience-v1`을 유지하고 출력 검증기는 `api-experience-output-v2`다. 단일 완결 Markdown 코드 블록으로 둘러싼 Python/JSON은 검사할 때만 포장을 벗겨 내용 조건을 확인한다. 모델 출력·토큰·시간은 바꾸지 않는다. `valid_output=true`여도 `format_compliant=false`, `presentation_wrapper=markdown_fence`이면 형식 지시 불이행이 남아 있다는 뜻이며 지능 정답으로 채점한 것이 아니다. 불완전하거나 여러 블록/추가 설명이 섞인 포장은 허용하지 않는다. compact 응답도 이 진단을 포함한다. 예열·오류·출력 잘림과 속도 계측 조건은 성능 집계에서 별도로 검증한다.

새 시험은 응답 수집 후 이 규칙을 자동 적용한다. 기존 `api-experience-v1` 출력 판정은 앱 시작 시 완료·성공한 저장 응답만 자동 갱신하고 서비스 시작 전에 저장한다. 구버전 기록 가져오기와 휴지통 복구에도 같은 규칙을 자동 적용한다. 이전 판정은 `grading_history`에 남고 지능 채점·원문·원시 프레임·계측 값은 유지한다. 모델·외부 채점기 호출이나 재시험은 발생하지 않으며 이미 v2인 기록은 다시 변경하지 않는다.
