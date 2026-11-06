#!/bin/zsh
set -eu
print "Python이 없는 경우에만 한 번 설치합니다."
print "공식 Python 3.14 설치 페이지를 엽니다. macOS installer를 내려받아 설치해 주세요."
print "이 도구는 시스템 Python을 지우거나 보안 설정을 바꾸지 않습니다."
open "https://www.python.org/downloads/release/python-31410/"
if [[ -t 0 ]]; then
  read "bench_reply?설치 후 Enter를 누르세요. 내장 시험부터 쓰려면 설치하지 않고 Enter를 누르면 됩니다: "
fi
