# 제3자 자료 고지 · 로컬 베타 준비판

검토일: 2026-11-06. 이 문서는 포함하는 제3자 자료의 출처와 고지이며 앱 자체에 라이선스를 부여하지 않는다. 앱 자체의 공개 이용허락은 소유자가 별도로 결정한다. 기본 번들은 아래 허용목록의 자료와 관련 고지를 함께 담는다.

## 기본 데이터팩

| 파일 | 출처·권리자 | 확인한 라이선스 | 이 앱의 가공 |
|---|---|---|---|
| `datasets/gsm8k-test-v1.json` | OpenAI, GSM8K | MIT | test 1,319문항을 앱 스키마로 변환, 정답 추출 및 고정 빠른50 ID 추가 |
| `datasets/ifeval-full-v1.json` | Google Research, Zhou 외, IFEval | Apache-2.0 | 공식541문항을 앱 스키마로 변환, 고정 빠른50 ID 추가 |
| `datasets/humaneval-full-v1.json` | OpenAI, HumanEval | MIT | 공식164문항·테스트를 앱 스키마로 변환, 고정 빠른25 ID 추가 |
| `datasets/mbpp-test-v1.json` | Google Research, Austin 외, Mostly Basic Python Problems | CC BY 4.0 | test ID11–510의500문항, 공식 예시 ID2·3·4를 포함한3-shot 프롬프트, 고정 빠른25 ID 추가 |
| `datasets/mmlu-pro-test-v1.json` | TIGER-Lab, Wang 외, MMLU-Pro | MIT (데이터); 코드 저장소는 별도 Apache-2.0 | test 12,032문항, 같은 과목 validation의 5-shot, 고정 빠른100 ID |
| `datasets/math500-test-v1.json` | OpenAI PRM800K/Lightman 외, MATH/Hendrycks 외, H4 변환 | MIT (PRM800K 및 원 MATH) | 동일 원본500문항을 앱 스키마로 변환, boxed 답안 지시 및 빠른50 ID 추가 |
| `datasets/bbh-cot-full-v1.json` | Mirac Suzgun 외, BIG-Bench Hard; 원 BIG-bench/Srivastava 외 | MIT (BBH); Apache-2.0 (원 BIG-bench) | 전체6,511문항·27하위구성, 공식3-shot CoT, 하위구성별2개씩 빠른54 ID |

정확한 데이터 리비전·원본 SHA256·문항 ID는 각 팩의 `sources` 및 `datasets/sources/download-manifest.json`에 기록한다. 빠른 시험은 공식 전체 점수와 구별한다. 이 변환·선택·실행기는 upstream의 공식 제품이나 승인을 뜻하지 않는다.

- GSM8K: [공식 저장소](https://github.com/openai/grade-school-math), [MIT 원문](https://raw.githubusercontent.com/openai/grade-school-math/master/LICENSE). 동봉: `LICENSES/GSM8K-MIT.txt`.
- IFEval: [공식 코드·데이터](https://github.com/google-research/google-research/tree/master/instruction_following_eval), [Google 데이터 카드의 Apache-2.0 표기](https://huggingface.co/datasets/google/IFEval), [Apache 원문](https://www.apache.org/licenses/LICENSE-2.0). 동봉: `LICENSES/IFEval-Apache-2.0.txt`, `docs/licenses/IFEval-dataset-card.md`. 변환된 팩은 원래 파일과 다른 앱 스키마이며, vendored Python 파일은 아래 고정 원문이다.
- HumanEval: [공식 저장소](https://github.com/openai/human-eval), [MIT 원문](https://raw.githubusercontent.com/openai/human-eval/master/LICENSE). 동봉: `LICENSES/HumanEval-MIT.txt`.
- MBPP: Google Research / Austin et al., *Program Synthesis with Large Language Models* (2021), [원본 자료 및 평가 규약](https://github.com/google-research/google-research/tree/master/mbpp), [데이터 카드](https://huggingface.co/datasets/google-research-datasets/mbpp), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 및 [이용허락 원문·보증 부인](https://creativecommons.org/licenses/by/4.0/legalcode.en). 동봉: `LICENSES/MBPP-dataset-card.md`, `LICENSES/MBPP-README.md`. CC BY 4.0 자료는 해당 라이선스 조건에 따라 재이용할 수 있으며 앱 자체 이용허락과 구별한다. 원본에서 수행한 변경은 위 표와 각 팩 `sources`에 표시했다. MBPP 저장소 코드의 Apache 라이선스를 데이터의 CC BY 4.0 대신 사용하지 않는다.

- MMLU-Pro: [공식 데이터 카드](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro/blob/b189ec765aa7ed75c8acfea42df31fdae71f97be/README.md)의 `license: mit`를 따른다. TIGER-Lab, Wang et al., *MMLU-Pro: A More Robust and Challenging Multi-Task Language Understanding Benchmark* (2024). 동봉: `docs/licenses/MMLU-Pro-dataset-card.md`, `docs/licenses/MMLU-Pro-data-MIT.txt`. 데이터의 MIT와 저장소 코드의 Apache-2.0를 구별한다.
- MATH-500: H4 [공식 카드](https://huggingface.co/datasets/HuggingFaceH4/MATH-500)가 가리키는 [OpenAI PRM800K](https://github.com/openai/prm800k)의 `prm800k/math_splits/test.jsonl`과 500문항을 전수 대조했다. 문제·정답·풀이·원본 ID·과목·난도가 모두 일치한다. 원본의 MIT 고지 `docs/licenses/PRM800K-MIT.txt`(2023 OpenAI)와 `docs/licenses/MATH-MIT.txt`(2021 Dan Hendrycks)를 동봉한다. H4 카드·PRM800K README와 `docs/math500-source-equivalence.json`이 출처 및 동일성 증거다. 판정기는 Math-Verify 0.9.0이며 원 논문의 채점기와 동일하다고 표시하지 않는다.
- BBH: Suzgun et al., *Challenging BIG-Bench Tasks and Whether Chain-of-Thought Can Solve Them* (2022), [공식 저장소](https://github.com/suzgunmirac/BIG-Bench-Hard/tree/9ee07bd481feebf959a6b59d61ea57bdcf30964d). `docs/licenses/BBH-MIT.txt`(2022 suzgunmirac)와 README, [원 BIG-bench](https://github.com/google/BIG-bench)의 `docs/licenses/BIG-bench-Apache-2.0.txt`를 보존한다. 원 과제명·평가용 canary·출처·변경 정보를 유지한다. 원 논문의 23과제는 항목 수가 다른 구성을 나누면 27개 JSON이다. 빠른54 결과를 전체6,511 결과로 표시하지 않는다. 입력이 손상된 `snarks:0088`과 동일 입력에 정답이 상충하는 `causal_judgement:0032/0119`, `causal_judgement:0036/0104` 등 총 5문항은 원문을 보존하고 점수 불가로 분리한다. 전체 최대 채점 수는 6,506이며 빠른 54문항에는 이 5개가 없다.

`api-experience-v1.json`의13개 항목은 이 프로젝트에서 작성한 합성 성능 프롬프트다. 외부 벤치 데이터로 표시하지 않는다. 현재 파일의 기존 CC0-1.0 표기는 감사 대상의 메타데이터이며, 이 고지는 앱 전체나 다른 데이터에 CC0를 적용하지 않는다. 앱·자체 작성물의 최종 공개 이용허락은 배포 담당자가 확정한다.

## 포함하지 않는 데이터

`livecodebench-v6-v1.json`, LCB 테스트 sidecar 및 원본 다운로드 캐시는 기본 번들에서 제외한다. MATH-500과 MMLU-Pro는 공식 근거를 재검토하여 기본 포함으로 정정했다. 로컬 설치용 주소 목록은 포함할 수 있지만 파일 자체의 재배포 승인을 뜻하지 않는다. 상세 근거는 `DISTRIBUTION-LICENSE-AUDIT.md`를 따른다.

기존 `public-core.json`은 최신 전체 팩과 중복되는 legacy 구성이라 기본 번들에서 제외한다. MMLU-Pro 데이터가 들어 있다는 이유의 라이선스 제외는 적용하지 않는다. 기존 한국어 참고팩도 신규 배포 선택에서 제외한다. 로컬의 시험 기록·답변·API 원시 이벤트·DB·키·장비 식별정보·스크린샷을 번들에 넣지 않는다.

## 고정 원문의 채점 코드

| 로컬 파일 | upstream | 동봉 라이선스 |
|---|---|---|
| `scorers/vendor/humaneval_execution.py` | OpenAI HumanEval `6d43fb980f9fee3c892a914eda09951f772ad10d` | `LICENSES/HumanEval-MIT.txt` |
| `scorers/vendor/instruction_following_eval/*.py` | Google Research `107e33477ec7418e16b6a2c50f68dab8d82cf9b1` | `LICENSES/IFEval-Apache-2.0.txt` |
| `scorers/vendor/livecodebench/testing_util.py` | LiveCodeBench `28fef95ea8c9f7a547c8329f2cd3d32b92c1fa24` | `LICENSES/LiveCodeBench-code-MIT.txt` |

감사 시 manifest의6파일 SHA256이 로컬 파일과 모두 일치했다. 원문 저작권 머리글을 보존했다. 파일별 URL·SHA256은 `scorers/vendor/manifest.json`에 있다. LCB 코드의 MIT는 LCB 문제 데이터의 라이선스 확인을 대신하지 않는다. Python 브리지, 코드 추출, Docker 연결 및 자체 수치/선택지 판정은 별도 앱 구현이다.

## 실행 의존성·폰트

- Rust 바이너리와 React/아이콘이 포함된 JavaScript 번들의 Cargo/npm 의존 고지는 번들의 `THIRD-PARTY-LICENSES/{rust,npm}/`, 목록은 `DEPENDENCIES.json`에 동봉한다. 빌드 도구 의존성도 포함하는 보수적 상위 집합이며 각 패키지가 모두 실행 파일에 링크됐다는 뜻은 아니다. 자동 목록에서 미기재 또는 원문 누락 항목이 있으면 배포 검토 대상으로 남긴다.
- Cargo.lock 밖에서 정적으로 포함될 수 있는 Rust 표준 라이브러리 고지도 `licenses/rust-toolchain/`에 보존했다. Rust 1.97.1의 공식 `COPYRIGHT-library.html`, MIT/Apache 원문, 설치된 rust-src 구성 요소 및 Unicode-3.0 원문을 포함한다. 파일별 출처·SHA-256은 `rust-toolchain-notices.json`에 있다. 다른 도구체인으로 다시 빌드할 때 함께 갱신한다.
- Python scorer의 현재 필수 설치 의존15개와 버전·원문 해시는 `python-dependencies.json`, 고지는 `licenses/python/`에 있다. `.venv`, Python 인터프리터, wheel, Docker 이미지는 이 기본 번들에 포함하지 않고 사용자의 환경에 설치한다. 제공한 고지는 감사일의 로컬 환경 기록이며 향후 다른 전이 버전 설치에 대한 라이선스 목록을 대신하지 않는다.
- `regex`는 Apache-2.0와 CNRI 계열 표기가 함께 있고, `tqdm`은 MPL-2.0와 MIT 표기가 있다. 이 목록을 전부 MIT라고 표현하지 않는다. Python 실행 파일을 번들하는 배포 방식으로 바꿀 경우 정확한 배포물·변경 파일·고지 및 소스 제공 조건을 다시 확인한다.
- CSS는 Inter, Apple SD Gothic Neo, Malgun Gothic 등의 이름을 시스템 폴백으로 지정한다. 감사한 소스에는 폰트 바이너리·`@font-face`·외부 폰트 다운로드가 없다. 시스템 폰트의 복제본을 패키지에 추가하지 않는다.
- NLTK의 `punkt`·`punkt_tab`은 Python 라이브러리와 별도의 모델 자료다. 기본 패키지에 NLTK 데이터 디렉터리/zip을 넣지 않는다. 공식 다운로드 방식으로 사용자 환경에 설치하며, 향후 offline 포함 시 각 배포 archive의 고지를 별도로 확인한다.

이 문서는 실제 기본 번들에 대한 제3자 고지다. 제외 자료나 설치 의존성을 일괄 재라이선스하거나 앱 소유자의 공개 이용허락을 대신하지 않는다.
