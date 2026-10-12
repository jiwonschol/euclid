# 상대 의도 전달 계약

기준 main: `0b3b0cf80bcca924a06825b2a3133537656ebaff`.
구현·결함 주입 대상: `5f79b74ad6dd4c28c5db01cd7d49d98d04b9f347`.

seed 32 / patient / 21번째 국면에서 상대 `delay_drop`이 측면 지원 풀백을 온사이드로 만든다. 상대 의도를 생략한 `legal`은 거부하고, 의도를 포함한 `legal`은 허용하는 것을 먼저 단언한다. 이 같은 국면에서 버튼·예약·확정이 모두 측면 지원을 허용해야 한다.

버튼의 호출 인자 조립만 `cards.js`의 순수 함수 `cardButtonReason`으로 옮겼다. `main.js`는 이 함수에 같은 스냅샷·명령·game을 전달한다. `legal`, 경기 규칙·수치, `match.js`, `resolve.js`의 판정은 변경하지 않았다. 기존 계약 검사의 기대값도 바꾸지 않았다.

깨끗한 구현 커밋에서 다음 세 지점의 `opponentIntent` 인자를 하나씩 제거하고 `node sim/director-contracts.mjs`를 실행했다. 각 실행은 exit 1로 실패했고, 매번 수정 인자를 복원한 뒤 다음 지점으로 진행했다.

| 제거 지점 | 실패 메시지 | 실제 값 / 기대값 |
|---|---|---|
| 버튼 (`cardButtonReason`의 `legal` 호출) | `button must include opponentIntent` | `이동 뒤 패스를 받을 수 있는 풀백이 없습니다.` / `null` |
| 예약 (`DirectorMatch.queue`) | `reservation must include opponentIntent` | `이동 뒤 패스를 받을 수 있는 풀백이 없습니다.` / `null` |
| 확정 (`DirectorMatch.commit`의 사전 검사) | `commit must include opponentIntent before recording input` | `{ id: 'hold', side: 'left' }` / `{ id: 'support_flank', side: 'left' }` |

확정 검사는 resolver가 거부하는 최종 결과만 보지 않고, 사전 합법성 검사 후 inputLog에 남는 명령도 검사한다. 예약을 거치지 않고 pending을 주입하므로 예약 검사의 성공에 기대지 않는다. 버튼 검사는 game 해시가 변하지 않는 것도 단언한다. 새 세 검사는 소스 문자열을 찾지 않고 실제 함수를 실행한다.

복원 뒤 `git diff HEAD --exit-code`와 계약 27그룹이 통과했다. Node v22.23.2에서 `npm run test:director` 전체(계약 27그룹·전술 18개·에셋 25개·400경기·320재생)가 통과했다. 검사 시작은 기준 main에 위 구현 변경이 있는 상태이며, 실행 중 커밋한 구현 내용은 같았다.

400경기 실행의 출력 JSON 전체 필드를 main의 `docs/director-evidence/playthrough.json`과 `assert.deepEqual`로 대조해 같음을 확인했다. 400경기·320재생, 304–329초, 청해/홍림 골 239/103·슛 732/295 및 모든 사건 집계가 같다. main의 집계 파일은 수정하지 않았다. 브라우저 화면은 이번 계약 검사로 확인하지 않았다.
