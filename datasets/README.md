# 기본 벤치팩과 원본 자료

새 시험에서는 동봉된 **기본 벤치팩** 하나를 선택하고 **10분·1시간·4시간·8시간** 중 실행 모드를 고른다. 팩 ID는 `basic-bench-v2`, 확정 버전은 **`2026-11-09.1`**이다. 일반 사용자는 아래 원본 자료를 다시 내려받거나 변환할 필요가 없다.

| 실행 모드 | 문항 수 | 용도 |
| --- | ---: | --- |
| 10분 | 41 | 연결과 기본 능력 확인 |
| 1시간 | 160 | 주요 능력 비교 |
| 4시간 | 536 | 분야별 상세 검토 |
| 8시간 | 1,010 | 더 넓은 분야와 난도의 상세 검토 |

짧은 모드의 모든 문항은 긴 모드에 포함된다. `basic-pack/manifest-v2.json`에 문항 ID·순서·출처 해시와 시간 보정 근거를 고정한다. 각 모드는 선택된 전체 문항을 사용하며, 원본 팩의 빠른 표본 옵션을 다시 적용하지 않는다. 과목을 일부 제외하면 문항 수와 시간이 줄어든다.

시간 이름은 기준 모델에서 보정한 실행 분량이며 다른 모델의 완료 시간을 보장하지 않는다. 긴 두 모드의 출력 실패와 미해결 진단을 포함한 실측·재현 설정·평가 한계는 [기본 벤치팩 안내](../docs/BASIC-PACK.md)를 따른다. 발췌판의 점수를 원본 전 문항 점수와 동일하게 해석하지 않는다.

## 기본팩의 원본 출처

다음 7종 **21,567문항**은 기본팩을 구성하는 내부 출처 자료다. 원본 파일·공식 프롬프트·채점 조건을 보존하며, 새 시험의 기본 선택 목록에는 이 7종 대신 기본 벤치팩 하나를 표시한다.

| 원본 벤치 | 원본 문항 수 | 구성 |
| --- | ---: | --- |
| GSM8K | 1,319 | 공식 test 전체 |
| MATH-500 | 500 | 공식 test 전체 |
| MMLU-Pro | 12,032 | test 전체, category별 validation 5-shot |
| IFEval | 541 | 공식 입력 전체 |
| HumanEval | 164 | 공식 함수·테스트 전체 |
| MBPP | 500 | 공식 test ID 11–510, 3-shot ID 2·3·4 |
| 복합 논리 추론 · BIG-Bench Hard | 6,511 | 공식27하위구성·3-shot CoT |
| 합계 | 21,567 | 기본팩의 원본 출처 7종 |

문제 프롬프트만 모델 API로 전달하고 `answer`와 채점용 `meta`는 전달하지 않는다. MBPP 공식 프롬프트의 공개 예시 테스트와 3-shot 정답 예시는 공식 규약에 포함되지만 현재 평가 문항의 정답 코드는 전달하지 않는다.

## 호환 자료와 별도 설치 자료

- **응답 사용성 · API Experience 13문항**은 기존 결과와의 호환 및 성능 기준 자료로 보존한다. 예열1회와 영어·한국어·코드·JSON 각3회로 구성하며 지능 채점과 분리한다. 기본팩 네 모드의 문항 수에 더하지 않는다.
- **이전 v1 시간팩**과 시험 기록은 당시 이름·버전·문항으로 열 수 있다. 54·259·995·1,959문항 구성은 [v1 보관 기록](../docs/TIMED-PACKS.md)에 남긴다.
- **LiveCodeBench 1,055문항**은 `release_v6` code generation 전체를 별도 로컬 설치하는 자료다. 기본팩과 배포 번들에는 포함하지 않는다.
- **`public-core.json` 100문항과 자체 한국어32문항**은 과거 기록 재현용 legacy 자료다. 신규 선택과 배포 번들에서 제외하며, 자체 한국어는 종합 점수에도 포함하지 않는다.

## 개발자용 원본 재생성과 검증

아래 명령은 출처 자료를 관리·재생성하는 개발자용이다. 일반 사용자의 설치 절차가 아니며, 원본을 다시 가져오는 것만으로 확정 기본팩의 버전이나 문항 구성을 바꾸지 않는다. 일반 사용자는 배포본에 동봉된 기본팩을 사용한다.

`tools/import_full_datasets.py`는 고정 리비전의 로컬 Hugging Face arrow 캐시를 우선 사용한다. 캐시 없는 환경에서는 `--download`로 공식 고정 URL의 원본을 직접 받아 설치한다. 데이터셋 원격 Python 코드를 실행하지 않고 JSONL·Parquet만 읽는다. 최초 준비에는 `tools/import-requirements.txt`의 pyarrow가 필요하다. `--cache-root`와 `--official-root`로 원본 위치를 바꿀 수 있다. 원본 캐시가 없고 다운로드도 지정하지 않았으면 정확한 경로를 출력하며 중단한다.

```sh
.venv/bin/python -m pip install -r tools/import-requirements.txt
.venv/bin/python tools/import_full_datasets.py --cache-root ~/.cache/huggingface/datasets
# 원본 캐시가 없는 개발 환경: 배포 가능한 자료만 받기
.venv/bin/python tools/import_full_datasets.py --download
# 로컬 전용 LiveCodeBench도 명시적으로 받기
.venv/bin/python tools/import_full_datasets.py --download --download-local-only
# 네트워크 접근·파일 변경 없이 URL, 예상 용량, 누락 자료 확인
.venv/bin/python tools/import_full_datasets.py --download --download-local-only --dry-run
.venv/bin/python tools/import_bbh.py --download
.venv/bin/python tests/dataset_contracts.py
.venv/bin/python tests/installer_contracts.py
# JSON 검증 결과도 저장하기
.venv/bin/python tests/dataset_contracts.py --json evidence/dataset-contracts.json
.venv/bin/python tests/installer_contracts.py --json evidence/installer-contracts.json
```

로컬 전용 자료가 없을 때 `--download`만 사용하면 해당 팩은 사유와 함께 건너뛴다. 이미 로컬에 있는 자료는 그대로 가져온다. `--download-local-only`는 개인 설치 허용을 구분하는 옵션이며 데이터 재배포 허가를 뜻하지 않는다. 공식 리비전·예상 바이트·SHA256은 `sources/download-manifest.json`에 고정했다. 임시 파일에 스트리밍한 뒤 크기와 해시가 맞을 때만 원본으로 채택한다. 실패한 임시 파일은 제거하고 기존 원본은 덮어쓰지 않는다. LCB 원본 6파일 약 4.2 GiB와 변환 결과 약 3.1 GiB가 필요하므로 신규 설치 전 여유 공간도 검사한다. 대용량 다운로드 경로는 공개 번들에서 제외한다.

팩마다 실제 문항 수, 원본 리비전, 원본 파일 SHA256, 선택 규칙과 라이선스 표기를 기록한다. LiveCodeBench 테스트는 별도 `sources/livecodebench-v6-tests/*.json.gz`에 전부 보관한다. manifest와 각 문제의 테스트 SHA256을 검증하고 모델에는 파일을 보내지 않는다. 원본 arrow 약 4.1 GiB를 압축 테스트 약 3.1 GiB로 준비했다.

## 채점 구현과 한계

* GSM8K: `####` 뒤 수치, 없으면 마지막 수치 추출. 공식 리더보드와 구분되는 앱 추출 규칙.
* MATH-500: Math-Verify 0.9.0으로 수식 동치 비교. 원본 MATH 채점기를 그대로 옮긴 것은 아니다. 정답 파싱 실패는 오답 대신 채점 불가.
* MMLU-Pro: 5-shot 공식 형식과 답안 문자 추출. 실패 시 임의 답안 선택 없음.
* IFEval: 고정 커밋의 공식 strict/loose 채점 코드. 기본 점수는 prompt-level strict 준수율.
* HumanEval: 공식 `execution.py`, Pass@1.
* MBPP: 공식 assertion 3개를 HumanEval 격리 실행 래퍼로 검사. 공식 테스트를 사용하되 실행 연결부는 앱 구현.
* LiveCodeBench: 공식 `testing_util.py/run_test`, 모든 공개·비공개 테스트, Pass@1. generic 프롬프트를 단일 user message에 맞춰 구성했다.
* BIG-Bench Hard: 공식3-shot CoT와 문항별 정답 정확 일치. 고정 Rust 추출 규칙을 사용하며 원 논문의23과제 평균과 다르다. 전체원본6,511문항을 포함하되 잘린 문항1개와 상충 정답4개는 오답이 아닌 채점 제외로 남긴다(최대6,506채점). 기존 지능·종합 지수 가중치에는 합산하지 않는다.
* 자체 한국어(과거 기록): JSON 구조와 값의 정확 일치. 신규 시험에서는 제외한다.

코드 실행은 네트워크·호스트 마운트 없는 읽기 전용 Docker에만 허용된다. HumanEval/MBPP의 기본값은 공식 Python digest이며, 배포 실행 스크립트는 코드 채점 모두 numpy 포함 `llm-bench-code:py311` 이미지를 지정한다. `docker build -t llm-bench-code:py311 - < scorers/Dockerfile`로 후자를 준비한다. 현재 개발 Mac에서 코드3종 정답·오답·시간 초과·취소·자원 회수 검사를 통과했다. 새 설치에서는 채점 상태 검사를 다시 수행한다. 베이스 이미지 digest를 고정하며 각 실행의 불변 image ID·아키텍처를 결과에 기록한다. 의존성 미설치·Docker 미연결·환경 제한시간 초과를 0점으로 처리하지 않는다. HumanEval/MBPP 문항 실행 10초, LCB 테스트당 8초·문항 컨테이너 600초 상한을 기록한다.

## 배포 범위

기본 번들은 기본팩의 manifest와 GSM8K·MATH-500·MMLU-Pro·IFEval·HumanEval·MBPP·BIG-Bench Hard의 원본 출처 자료를 포함한다. 합성 API Experience는 호환·기준 자료로 동봉한다. 이 파일들이 별도로 존재해도 새 시험의 기본 사용 흐름은 기본 벤치팩 하나와 네 실행 모드다. MATH-500은 공식 H4가 가리키는 OpenAI PRM800K 원본과500문항을 전수대조했고 원 MATH·PRM800K의 MIT 고지를 동봉한다. MMLU-Pro는 데이터의 MIT와 코드의 Apache-2.0를 구분해 보존한다. BBH는MIT/원BIG-bench Apache 고지와원자료canary를 유지한다.

LiveCodeBench 문제·테스트 데이터의 재배포 조건은 검토가 남아 별도 로컬 설치로 둔다. 자체 한국어·legacy public-core도 배포에서 제외한다. 최신 조건과 원문 고지는 `../docs/THIRD-PARTY-NOTICES.md`와 `../docs/DISTRIBUTION-LICENSE-AUDIT.md`를 따른다. 추가 후보 ARC/WinoGrande는 검토 자료일 뿐 현재 설치·동봉 팩이 아니다.

BBH 재생성은 `tools/import_bbh.py --download`를 사용한다. `sources/bbh-manifest.json`에 고정한 파일·SHA256을 확인하며 기본은 네트워크 호출 없이 로컬 원본으로 재생성한다. 세부 채점·자료 결함·검증 근거는 `../docs/BBH-PACK.md`을 따른다.
