#!/usr/bin/env python3
"""Save the user's AI-guided installation choices in a running local LLM Bench.

Uses only Python's standard library. Does not install components, send benchmark
questions, store API keys, or mark a component as ready without checking it.
"""
import argparse
import ipaddress
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def local_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname or ""
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
        port = parsed.port
    except ValueError:
        raise argparse.ArgumentTypeError("벤치 앱의 localhost/loopback 주소를 입력하세요.")
    if (not local or parsed.scheme != "http" or parsed.username is not None
            or parsed.password is not None or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or port is None):
        raise argparse.ArgumentTypeError("http://127.0.0.1:18760 형식의 로컬 앱 주소가 필요합니다.")
    return value.rstrip("/")


def request(opener, base, path, value=None):
    body = None if value is None else json.dumps(value).encode("utf-8")
    req = urllib.request.Request(base + "/api/" + path, data=body,
                                 headers={"Content-Type": "application/json"})
    with opener.open(req, timeout=15) as response:
        raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("앱 응답이 예상보다 큽니다.")
        return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description="AI가 확인한 설치 선택을 로컬 앱에 저장합니다.")
    parser.add_argument("--api-url", type=local_url, default="http://127.0.0.1:18760")
    parser.add_argument("--model-location", choices=("local", "remote"), required=True)
    parser.add_argument("--device-collection", choices=("yes", "no"), required=True)
    parser.add_argument("--code-grading", choices=("yes", "no"), required=True)
    parser.add_argument("--dry-run", action="store_true", help="저장할 선택만 표시하고 요청하지 않습니다.")
    args = parser.parse_args()
    preferences = {
        "schema_version": 1, "model_location": args.model_location,
        "device_collection": args.device_collection == "yes",
        "code_grading": args.code_grading == "yes", "completed": True,
    }
    if args.dry_run:
        print(json.dumps({"saved": False, "preferences": preferences}, ensure_ascii=False))
        return 0
    # Ignore system proxies: installation choices stay on the local app host.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        request(opener, args.api_url, "setup")
        request(opener, args.api_url, "setup", preferences)
        saved = request(opener, args.api_url, "setup")["preferences"]
        if any(saved.get(key) != value for key, value in preferences.items()):
            raise ValueError("선택을 다시 읽은 결과가 저장 요청과 다릅니다.")
    except (urllib.error.URLError, OSError, ValueError, KeyError) as exc:
        # Do not echo an arbitrary response body or request credentials.
        detail = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
        print(f"설치 선택 저장 실패 ({detail}). 로컬 앱 실행과 주소를 확인하세요.", file=sys.stderr)
        return 1
    print(json.dumps({"saved": True, "preferences": saved,
                      "next": "모델·장비 연결과 선택한 채점기의 실제 상태를 확인하세요. 시험은 시작하지 않았습니다."},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
