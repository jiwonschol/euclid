#!/bin/zsh
# 더블클릭용 실행 스크립트: 로컬 서버를 띄우고 브라우저를 연다.
cd "$(dirname "$0")"
open "http://localhost:8642"
exec python3 tools/serve.py 8642
