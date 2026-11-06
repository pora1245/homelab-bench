# 베타 배포 라이선스 감사

2026-11-06 / 대상: `llm-bench`의 데이터·채점 코드·설치 의존성·웹 폰트. 외부 게시·업로드·라이선스 변경을 수행하지 않았다. 기본 번들은 허용목록을 복사하는 방식으로 준비하고, 로컬 저장소 전체를 배포하지 않는다.

## 결론

**공식 배포자의 라이선스 명시와 데이터 출처를 기준으로 외부 팩 7종을 기본 번들에 포함한다.** GSM8K·HumanEval·MMLU-Pro·MATH-500·BBH의 MIT 고지, IFEval 및 BBH의 원 BIG-bench Apache-2.0 고지, MBPP의 CC BY 4.0 저작자·출처·라이선스 링크·변경 표시를 함께 제공한다. 본 감사가 배포 허가를 새로 만드는 것은 아니다. 앱 자체의 공개 라이선스는 아직 결정 기록이 없으므로 임의 MIT/Apache/CC0를 부여하지 않았다.

| 분류 | 파일/자료 | 근거와 처리 |
|---|---|---|
| 고지 동봉 조건으로 포함 | `gsm8k-test-v1.json` | OpenAI 공식 MIT. 1,319문항·변환 정보 및 저작권 고지 보존 |
| 고지 동봉 조건으로 포함 | `ifeval-full-v1.json` | Google 공식 데이터 카드도 Apache-2.0 명시. 저장소 코드 라이선스에서만 추정하지 않음 |
| 고지 동봉 조건으로 포함 | `humaneval-full-v1.json` | OpenAI 공식 MIT. 테스트·코드 고지 보존 |
| 고지 동봉 조건으로 포함 | `mbpp-test-v1.json` | 공식 HF 데이터 카드 CC BY 4.0. Google Research/Austin 외, 자료/라이선스 링크, 앱 스키마·split/3-shot/빠른 선택 변경 고지 작성 |
| 프로젝트 작성물 | `api-experience-v1.json` | 외부 데이터 아님. 기존 메타데이터는 CC0-1.0이나 앱 전체 공개 라이선스로 확대하지 않음. 앱 소유자 공개 정책의 확인 대상 |
| 고지 동봉 조건으로 포함 | `math500-test-v1.json` | H4 카드가 가리키는 OpenAI PRM800K의 `math_splits/test.jsonl`과 현재 500문항의 문제·정답·풀이·ID·과목·난도가 모두 일치. PRM800K 및 원 MATH 공식 MIT 고지 동봉 |
| 고지 동봉 조건으로 포함 | `mmlu-pro-test-v1.json` | TIGER-Lab 공식 데이터 카드의 MIT 명시를 따른다. 코드 Apache-2.0는 별도 대상이며 배제 근거가 아니다. 데이터 카드·저작자·MIT 조건 보존 |
| 고지 동봉 조건으로 포함 | `bbh-cot-full-v1.json` | Suzgun 외 공식 BBH 저장소 MIT, 원 BIG-bench Apache-2.0 고지 보존. 23과제의 난도별 하위 구성 27종, 전체 6,511문항과 3-shot CoT |
| 기본 번들 제외·로컬 설치 | `livecodebench-v6-v1.json`, 모든 테스트 sidecar | [데이터 카드](https://huggingface.co/datasets/livecodebench/code_generation_lite/blob/main/README.md)는 `cc`만 표기하고 세부 라이선스가 없음. LeetCode/AtCoder/Codeforces의 문제·테스트 권리를 코드 MIT로 대체하지 않음 |
| 중복·legacy 팩 제외 | `public-core.json` | 최신 전체 팩과 중복되는 legacy 100문항. MMLU-Pro를 포함한다는 이유의 라이선스 제외는 철회하고, 최신 팩만 배포한다는 기능상 제외를 유지 |
| 기능 범위상 제외 | `korean-core-v1.json` | 신규 한국어 평가에서 제외된 참고팩. 과거 로컬 기록만 보존; 권리 금지라는 판정은 아님 |

기본 외부 품질팩 7종은 총 21,567문항, 빠른 354문항이다. 2026-11-07부터 이 품질 문항 수가 신규 종합 시험의 전체·빠른 문항 수다. 합성 성능팩 13개는 과거 기록·기준값·API 호환용으로 동봉하지만 신규 선택과 종합 시험에서는 제외한다. 이전 8팩·21,580개/빠른 367개 실행 기록은 변경하지 않는다. LiveCodeBench는 기본 포함하지 않고 별도 로컬 설치 항목으로 안내한다. BBH의 27개 구성에서 2개씩 선택하는 빠른 54문항은 전체 점수와 구별한다. BBH 원본의 잘린 입력 1문항(`snarks:0088`)과 동일 입력에 정답이 상충하는 4문항(`causal_judgement:0032/0119`, `causal_judgement:0036/0104`)은 원문을 보존하되 점수 불가로 표시한다. 제외 대상은 총 5문항이며 전체 BBH의 최대 채점 수는 6,506이다. 빠른 54개에는 이 5문항이 없다.

## 감사 중 발견 및 조치

1. **재검토와 정정:** 초기 감사에서 MMLU-Pro의 모든 원천까지 추적하지 못했다는 이유와 MATH-500의 H4 카드에 라이선스 항목이 없다는 이유로 기본 팩을 과도하게 축소했다. 공식 데이터 MIT 명시와 PRM800K 원본 500개 일치를 추가 확인해 두 팩을 기본 포함으로 정정했다. 코드와 데이터 라이선스가 다르다는 사실만으로 배제하지 않는다. `public-core.json`은 라이선스 문제가 아니라 최신 팩과 중복된 legacy 구성으로 제외한다.
2. **MBPP 고지:** 기존 파일에 데이터 카드·코드 Apache는 있었으나 CC BY 4.0의 변환/저작자/라이선스 링크를 한곳에서 확인하기 어려웠다. `THIRD-PARTY-NOTICES.md`에 추가했다. Creative Commons의 [원문](https://creativecommons.org/licenses/by/4.0/legalcode.en)은 출처·변경 표시와 라이선스 링크를 요구한다. 링크를 동봉했으며 사이트의 `.txt` 직접 다운로드는HTTP403이어서 로컬 원문 파일을 생성했다고 주장하지 않는다.
3. **IFEval 데이터 권리:** [Google의 공식 데이터 카드](https://huggingface.co/datasets/google/IFEval)는 데이터 자체를 Apache-2.0으로 명시한다. 카드 복사본을 `licenses/IFEval-dataset-card.md`에 보존했다.
4. **vendored 코드:** manifest6개 파일의 해시가 원문 해시와 모두 일치했다. HumanEval MIT, IFEval Apache-2.0, LCB 실행 코드 MIT 고지와 원문 머리글을 보존한다.
5. **Python 고지 누락:** 현재 필수 의존15개 목록과 각 고지를 `python-dependencies.json` 및 `licenses/python/`에 수집했다. ANTLR wheel에 LICENSE가 없어서 [공식4.13.2 원문](https://github.com/antlr/antlr4/blob/4.13.2/LICENSE.txt)을 별도 보존했다. `.venv` 자체는 번들하지 않는다.
6. **전이 의존 버전:** 직접9개는requirements에고정됐으나 click/joblib/regex/tqdm/six/cloudpickle 등은 새 설치 시 다른 버전이 선택될 수 있다. 현재 inventory는감사일 로컬 버전이며 완전한 배포 lock으로 표시하지 않는다. 설치를 잠글 때 플랫폼별 버전/해시와 고지를 새로 기록해야 한다.
7. **Rust/npm 및 표준 라이브러리:** 패키징 담당이 Cargo/npm lock에 따른 고지를 `THIRD-PARTY-LICENSES/`와 `DEPENDENCIES.json`에 수집한다. 검토 중 Cargo.lock에 나오지 않는 Rust 표준 라이브러리의 고지 누락을 발견해 `licenses/rust-toolchain/`에 77개 원문과 `rust-toolchain-notices.json`을 추가했다. Rust 1.97.1 표준 라이브러리 manifest, MIT/Apache, compiler-builtins, backtrace, vendored crates, libunwind 및 Unicode-3.0을 보존했다. 표준 라이브러리 전체 라이선스 원문은 보수적 상위 집합이며 모든 구성 요소의 실제 링크 여부를 주장하지 않는다. 수집기는 중첩 LICENSE/NOTICE, UNLICENSE, lock 버전 일치도 확인해야 한다.
8. **폰트:** 시스템 폴백 이름만 지정돼 있고, 실제폰트파일·외부다운로드는 발견되지 않았다. 앱 SVG/HTML 내 폰트 이름은 폰트 바이너리의 재배포와 구별한다.
9. **NLTK 및 Docker:** Python패키지와 별개인punkt모델/OS이미지를묶지않는다. offline재배포로전환하면archive/OS패키지의고지와소스제공조건을검토해야한다. `python:3.11-slim`이라는태그만으로그안의전체파일라이선스를설명할수없다.
10. **MATH-500 원본 확인:** `math500-source-equivalence.json`에 PRM800K 공식 파일 SHA-256와 500문항의 6개 필드 완전 일치를 기록했다. 현재 데이터 수정은 배포 메타데이터만이며 문제·정답·빠른 선택은 보존했다. `dataset-expansion-sources.json`에 추가 고지의 URL·해시를 기록한다.
11. **앱 자체 라이선스:** Cargo.toml에는license선언이없고앱rootLICENSE도없다. 검토용로컬패키지는준비하되외부수신자에게어떤사용·복제·수정권리를주는지소유자가결정해야한다. 본감사에서권한을추정해라이선스를추가하지않았다.

## 패키지 허용목록

`distribution-allowlist.json`은 파일 단위의 데이터 포함 목록, 제외 목록 및 필수 고지 경로를 기록한다. 라이선스 확인은 데이터 복사 범위에 관한 것이며 앱 전체 공개 승인, 보안 검증, 새OS 검증을 뜻하지 않는다.

`data/`, `.venv/`, `node_modules/`, `.git/`, 다운로드 캐시, 개인 벤치 결과, API원시이벤트, screenshots, 장비기록은 배포본에서 제외한다. 공식 source 원본의 중복 복사도 필요하지 않다. manifest URL만 제공하는 것은 데이터 파일을 포함하는 것과 다르다.

## 확인한 공식 근거

- [GSM8K MIT](https://raw.githubusercontent.com/openai/grade-school-math/master/LICENSE)
- [HumanEval MIT](https://raw.githubusercontent.com/openai/human-eval/master/LICENSE)
- [IFEval 데이터 카드](https://huggingface.co/datasets/google/IFEval), [Google Research Apache-2.0](https://github.com/google-research/google-research/blob/master/LICENSE)
- [MBPP 카드](https://huggingface.co/datasets/google-research-datasets/mbpp), [MBPP 원본 평가 규약](https://github.com/google-research/google-research/tree/master/mbpp), [CC BY 4.0 법적 원문](https://creativecommons.org/licenses/by/4.0/legalcode.en)
- [MATH-500 카드](https://huggingface.co/datasets/HuggingFaceH4/MATH-500/blob/main/README.md)
- [MMLU-Pro 카드](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro/blob/main/README.md), [코드 저장소 LICENSE](https://github.com/TIGER-AI-Lab/MMLU-Pro/blob/main/LICENSE)
- [LCB 데이터 카드](https://huggingface.co/datasets/livecodebench/code_generation_lite/blob/main/README.md), [LCB 코드 LICENSE](https://github.com/LiveCodeBench/LiveCodeBench/blob/main/LICENSE)
- [ANTLR4 4.13.2 LICENSE](https://github.com/antlr/antlr4/blob/4.13.2/LICENSE.txt)
- [NLTK punkt 메타데이터](https://github.com/nltk/nltk_data/blob/gh-pages/packages/tokenizers/punkt.xml), [punkt_tab 메타데이터](https://github.com/nltk/nltk_data/blob/gh-pages/packages/tokenizers/punkt_tab.xml)

## 다음 확장 후보 · 이번 번들 미포함

| 후보 | 용도와 평가 범위 | 공식 권리 근거 | 판단 |
|---|---|---|---|
| ARC-Challenge | 과학 추론, 공개 test 1,172문항, 선택지 정답 정확도 | [AllenAI 공식 카드](https://huggingface.co/datasets/allenai/ai2_arc)의 CC BY-SA 4.0 | 출처·변경·동일조건을 해당 데이터팩에 표시하면 포함 후보. 앱 전체 라이선스와 별개로 팩 권리를 유지한다. 생성형 선택지 평가와 원본 likelihood 방식은 구별 |
| WinoGrande | 상식·지시대상 추론, 정답이 공개된 validation 1,267문항 | [공식 다운로드 스크립트](https://github.com/allenai/winogrande/blob/master/download_winogrande.sh)가 제공하는 v1.1 zip의 README에 데이터 CC BY 2.0 명시 | 포함 후보. `licenses/WinoGrande-archive-README.md` 보존. test 1,767문항은 라벨이 비공개이므로 로컬 시험은 validation으로 명시해야 함 |

현재 확장은 MMLU-Pro·MATH-500 복원과 BBH 추가까지다. 후보를 구현 완료로 표시하지 않는다.
