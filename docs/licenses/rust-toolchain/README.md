# Rust 표준 라이브러리 고지

이 폴더는 macOS arm64 실행 파일을 만드는 데 사용한 Rust 1.97.1의 표준 라이브러리 고지를 보관한다. Cargo.lock의 앱 의존성 목록과 별개다.

- `share/doc/rustc/COPYRIGHT-library.html`: 설치된 도구체인이 제공하는 표준 라이브러리 저작권 목록 원문.
- `LICENSE-MIT`, `LICENSE-APACHE`, `COPYRIGHT`: 설치된 Rust 배포본의 원문.
- `stdlib-sources/`: 설치된 rust-src의 표준 라이브러리 구성 요소, vendored crates 및 libunwind에서 수집한 고지 원문. 플랫폼별·미사용 구성 요소도 포함하는 보수적 상위 집합이며, 모든 파일이 실제 앱에 링크되었다는 뜻은 아니다.
- `LICENSE-UNICODE-3.0`: 로컬 `unicode-ident 1.0.27` 패키지의 변경하지 않은 Unicode-3.0 원문. 표준 라이브러리 Unicode 데이터의 별도 저작권 표시는 `COPYRIGHT-library.html`에 보존했다.

파일별 출처와 SHA-256은 `docs/rust-toolchain-notices.json`에 있다. 배포 바이너리를 다른 Rust 버전으로 다시 빌드하면 이 목록도 갱신해야 한다. Rust 컴파일러나 Cargo 실행 파일 자체는 앱 번들에 포함하지 않는다.
