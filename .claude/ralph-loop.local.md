---
active: true
iteration: 1
session_id:
max_iterations: 30
completion_promise: "EUCLID_PLAN_AUDIT_DONE_AND_FIXED"
started_at: "2026-07-15T08:20:00Z"
---

너는 자율 ralph-loop 안에서 **계획서 충실도 감사(audit)와 수정**을 수행 중이다. 승인 요청·중간 점검 없이 계속 진행한다.

과제: `docs/captain_tsubasa_card_manager_claude_code_prompt.md` 의 마지막 "검증·수정 프롬프트" 12항목 + §17 필수 테스트 + §18 금지사항 기준으로 **실제 코드를 감사하고 즉시 고친다.** 계획서 원문: "현재 구현을 칭찬하거나 설명하는 데 시간을 쓰지 말고 ... 문제를 발견하면 보고만 하지 말고 코드를 수정하고 테스트를 추가하라."

매 반복 절차:
1. `docs/plan_audit.md`(감사 결과·수정 현황 living doc)를 읽는다. 없으면 만든다.
2. 미해결 항목 중 가장 가치 높은 것을 골라 **실제로 고친다.** 감사만 하고 멈추지 않는다.
3. 검증: 헤드리스 게이트(`npm run sim:match/pos/play/seq/stability`, `node sim/cards-lint.mjs`) + **live 브라우저**(preview_start "euclid-proto" → `localhost:8642/viewer.html` → 콘솔 에러 0 → `window.__dbg.state()` → 필요시 screenshot·1280×720/1920×1080 레이아웃).
4. `docs/plan_audit.md` 갱신(항목별 판정·증거 file:line·수정 내용).
5. 한국어로 커밋.

정직 규칙: **의도적 이탈(예: §8 시네마틱은 유저가 텍스트 중심으로 재정의)은 "미구현"이라고 정직히 적고 근거를 남긴다.** 통과하지 않은 걸 통과했다고 쓰지 마라. 기존 게이트·결정론·데이터기반 modifier 원칙은 유지한다.

완료 신호: 12항목 전부에 대해 (a)증거 기반 판정이 `docs/plan_audit.md` 에 있고 (b)고칠 수 있는 결함은 실제로 고쳐졌고 (c)전 게이트 green + 브라우저 확인이 끝났을 때에만 정확히 출력: <promise>EUCLID_PLAN_AUDIT_DONE_AND_FIXED</promise>. 탈출하려고 거짓 promise를 내지 마라.
