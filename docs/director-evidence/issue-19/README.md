# #19 경기 컷 검증 사진

`director.html`의 실제 Chromium 렌더다. 코드 커밋 `0db303c`에서 전체 Director 스위트(400경기·320회 재현 비교)가 통과했다. 이 폴더 추가는 코드·판정 변경 없이 PR에 공개할 사진만 저장한다.

대표 컷은 시드 42, 1280×720, 1배속, 첫 국면에서 측면 지원을 고른 결과다. `run`, `choose`, `directive`, `opponent`, `ours`, `result` 순으로 달리기·선택·지시·홍림·청해·결과를 보여준다. `support_flank-*`와 `hold-*`는 `?fixture=attack`의 같은 시작 상태와 시드에서 서로 다른 선택을 한 사진이다. `goal`과 `save`는 실제 판정을 찾는 기존 `?outcome=GOAL|SAVE` 검사 경로다.

촬영은 Playwright의 가상 시계를 사용한다. 첫 국면에서 READY 후 0.5초에 달리기, COMMAND 진입 뒤에 선택 화면, 카드 클릭 직후에 지시 이름을 찍었다. 이후 1.5초에 홍림, 2초에 청해, 3.1초에 결과를 찍었다. 별도로 첫 세 국면의 0.5초 간격 45장과 레이아웃·일곱 결과·종료 화면은 팀 공유 `/srv/buzz-shared/EUCLID_19_FRAMES_0DB303C.tar.gz`에 있다.

검증 결과와 남은 사람 플레이 평가는 [진행 문서](../../director-progress.md)를 본다. 원작 조사와 새 이미지 생성은 구분한다. 이 사진들은 새 경기 에셋이 아니다.

사진은 아래 고정 커밋에 보존한다. 현재 브랜치에는 검증용 PNG를 포함하지 않는다.

| 컷 | 사진 | 컷 | 사진 |
| --- | --- | --- | --- |
| 달리기 | [run](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/run.png) | 선택 | [choose](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/choose.png) |
| 지시 | [directive](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/directive.png) | 상대 | [opponent](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/opponent.png) |
| 우리 | [ours](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/ours.png) | 결과 | [result](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/result.png) |
| 지원 지시 | [support_flank-directive](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/support_flank-directive.png) | 지원 결과 | [support_flank-result](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/support_flank-result.png) |
| 유지 지시 | [hold-directive](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/hold-directive.png) | 유지 결과 | [hold-result](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/hold-result.png) |
| 골 | [goal](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/goal.png) | 선방 | [save](https://raw.githubusercontent.com/jiwonschol/euclid/d7a62dcb1d1d8212604f3adaca854c7d26a4e58c/docs/director-evidence/issue-19/save.png) |
