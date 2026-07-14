# 그라운드의 유클리드 — 프로토타입 v0.1

계획서: [docs/euclid_game_prototype_plan.md](docs/euclid_game_prototype_plan.md)

## 실행 방법

브라우저 보안 정책 때문에 `index.html`을 더블클릭으로 직접 열면 JSON 데이터를 읽지 못합니다.
아주 작은 로컬 서버 하나만 띄우면 됩니다 (설치 불필요, 맥 기본 파이썬 사용):

- **가장 쉬운 방법**: `start.command` 파일을 더블클릭 → 브라우저가 자동으로 열립니다.
- 또는 터미널에서: `npm start` 실행 후 <http://localhost:8642> 접속.

## 밸런스 조정 (디자이너용)

코드를 건드릴 필요 없이 `/data/*.json`만 수정하면 됩니다:

| 파일 | 내용 |
|---|---|
| `data/config.json` | 개입권 수, 장면 수, PRD 스텝, 배속, 적응 페널티 등 계획서 §15의 모든 상수 |
| `data/scenes.json` | 장면 풀 (가중치·웨이포인트·결과 확률·카운터·참모 신호) |
| `data/caster.json` | 캐스터 멘트 (조건부 재맥락화), 컷인 문구 |
| `data/advisors.json` | 참모 2인 (얼굴 이모지·대사 스타일·신호 타이밍) |
| `data/cards.json` | 카드 4종 정의 |

수정 후 브라우저 새로고침만 하면 반영됩니다.

## 밸런스 검증 (헤드리스 시뮬)

```
npm run sim              # 1000경기 무개입 시뮬: 득점 분포·장면 분포·PRD 수렴 확인
node sim/headless.mjs 1000 --with-cards   # 참모 신호를 따르는 정책으로 시뮬
npm run sim:motion       # 모션 게이트 린트: 속도 상한·진형 유지·공 물리 (docs/motion_engine_plan.md §4)
```

움직임(속도·진형·공 물리) 튜닝은 `data/config.json`의 `motion` 블록 — 수치가 실제 축구 m/s 단위입니다.

## 구조

- `js/engine/*` — 순수 게임 로직 (DOM 없음, 브라우저와 시뮬이 공유)
- `js/ui/*`, `js/main.js` — 화면·입력·연출 타이밍
- `data/*.json` — 모든 수치와 콘텐츠 (디자이너 영역)
- `sim/headless.mjs` — 1000경기 통계 검증
