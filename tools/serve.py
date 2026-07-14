#!/usr/bin/env python3
# 개발용 정적 서버 — 캐시 완전 비활성 (Cache-Control: no-store).
# python3 -m http.server는 캐시 헤더를 안 보내서, 코드 수정 후 새로고침해도
# 브라우저가 옛 모듈(js)과 새 모듈을 섞어 로드하는 조용한 고장이 난다.
# README의 "수정 후 새로고침만 하면 반영"을 참으로 만드는 장치.
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
try:
    HTTPServer(("", PORT), NoCacheHandler).serve_forever()
except OSError:
    # start.command를 두 번 더블클릭하는 흔한 경우 — 스택트레이스 대신 안내 한 줄
    print(f"포트 {PORT}는 이미 사용 중 — 서버가 이미 떠 있습니다. 브라우저에서 http://localhost:{PORT} 를 열면 됩니다.")
