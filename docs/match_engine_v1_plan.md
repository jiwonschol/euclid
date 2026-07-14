# 연속 경기 엔진 계획 (match engine v1)

> **정본(SoT).** 이 문서는 마스터 계획서(`captain_tsubasa_card_manager_claude_code_prompt.md`)를
> euclid 실제 스택(바닐라 JS, 무빌드)에 적용한 구현 계약이다. 마스터 계획서가 "무엇을",
> 이 문서가 "이 저장소에서 어떻게"를 정한다. 충돌 시 임의 결정 금지 — 디자이너에게 질문.

## 0. 방향 결정 (2026-07-14, 디자이너 확정)

**A. 연속 경기 시뮬레이션.** euclid 의 기존 코어("확률로 장면을 먼저 판정 → 스크립트
애니메이션 재생")를 폐기하고, **고정 타임스텝에서 선수 AI·공 물리로 결과가 창발**하는
엔진으로 교체한다. 시네마틱은 창발한 결정적 순간을 확대해 보여줄 뿐, 결과를 정하지 않는다
(마스터 §1·§8·§18). 목표: *바둑알이어도 "진짜 축구 중계를 보는 듯한" 경기 + 하스스톤식 감독 손패.*

기존 프로토타입은 `main` 에 보존. 작업 브랜치 `feature/continuous-match-engine`.

## 1. 좌표계 (마스터 §3)

- 평면 `x`=길이축 ∈ [-52.5,+52.5](105m), `z`=폭축 ∈ [-34,+34](68m). 위 `y`=공 높이(선수 y=0).
- 원점 = 센터 마크.
- `attackDir`: 전반 A=+1(→+x), B=-1. 후반 둘 다 부호 반전(진영·좌우 앵커 반전).
- 자기 골문 x = `-attackDir*52.5`, 상대 골문 x = `+attackDir*52.5`.
- **시뮬 좌표(미터)와 렌더 좌표(픽셀)를 절대 섞지 않는다.** 변환은 UI 레이어 전담.
- 구현: [js/game/field.js](../js/game/field.js) — `FIELD`, `anchorToWorld`, `penaltyBoxOf`, `inBounds`.

## 2. 시간 (마스터 §3)

- 시뮬 주파수 `SIM_HZ = 15` → 한 틱 `SIM_DT = 1/15` 경기초. 물리·AI는 경기시간(실 m/s)으로 적분.
- 전·후반 각 `HALF_SECONDS = 2700`. 시계 누적 0..5400.
- **렌더 압축**: 라이브 재생 시 실프레임당 `압축배율×frameDt` 경기초를 누산기로 소비(기본 90분→~15분, 배율 ≈6). 속도 1×/2× 는 배율에 곱. 일시정지·결정창·시네마틱에서 시계 정지. 헤드리스는 전 틱 최고속.
- 모든 난수 = 시드 RNG([js/game/rng.js](../js/game/rng.js)). `Math.random` 금지. 상태 직렬화로 리플레이.

## 3. 상태 모델 (마스터 §4)

[js/game/match.js](../js/game/match.js) 의 JSDoc `@typedef` 가 정본. 핵심:
`MatchState{ phase, half, clockSeconds, score, attackDirection, possessionTeamId, players, ball, eventLog, rng, tickCount }`.
불변식(코드+테스트로 강제): 공 소유자 ≤1명 · `ownerId≠null ⇒ hasBall` · 퇴장 선수 제거 · 팀 활성 ≤11 ·
득점은 `GOAL` 이벤트로만 · 한 아웃당 재개 정확히 1회 · 모든 좌표/속도 유한(NaN 금지).

## 4. 단계 머신

`PRE_KICKOFF → KICKOFF → IN_PLAY → (HALFTIME) → IN_PLAY → FULLTIME`.
Stage 4~ 에서 `DECISION_WINDOW`(카드 선택창)·`CINEMATIC_RESOLUTION`·`STOPPAGE`(재개)·`PENALTY_SHOOTOUT` 추가.
확장 지점 = `tick()` 의 `IN_PLAY` 블록(현재 시계만; 여기에 AI·물리·규칙을 얹는다).

## 5. 재활용 / 폐기 지도 (기존 코드 기준)

**그대로 재활용** — `js/engine/rng.js`(→game/rng.js 로 계승) · `data/formations.json`(초기 배치) ·
`data/cards.json`·`caster.json`·`advisors.json` · `renderer.js`(연속 좌표+좌표변환 어댑터만) ·
`cutin.js` · `index.html`/`css` 레이아웃 · `sim/*.mjs` 하네스 패턴 · `motion-lint` 의 물리 게이트(속도/저크/겹침).

**축구 지식 이식** — `motion.js` 의 `seek`(가감속 캡)·`stepBall`(비행/드리블/정착·거리비례 속도·리드예측)·
`teamRawShape`/`computeDepthRanks`(라인·오프사이드 기하)·`assignPresser`(최근접 압박)·
`gkTarget`(GK 위치)·`computeSeparation`(겹침 분리)·`cardBackShift`. 스크립트 종속을 걷어내고 매 틱 AI 가 구동.

**폐기** — `data/scenes.json` · `motion.js:createMotion/stepActors` · `outcome.js`+`prd.js` ·
`sceneSelector.js` · `match.js` 의 scene 단위(beginScene/resolveScene/finishScene) · `main.js` 의 scene 프레임머신.

## 6. 로드맵 (마스터 §16, 각 단계 끝에 게이트)

- **Stage 1 — 시뮬 골격 ✅**: 좌표·22명·공·시계·단계머신·이벤트로그·시드 재현. 게이트 `sim/match-smoke.mjs`(16검사 통과).
- **Stage 2 — 포메이션·자율 이동 ✅**: 역할별 desired position, 공/점유 기반 팀 형태(공격·수비·전환), first defender + cover, 분리·속도/가속 캡, GK(수비/스위퍼). 게이트 `sim/positioning-lint.mjs`(몰림방지·압박≤2·역습대비·폭·측면추종·겹침·속도캡·풀경기 안정성·재현성). 라이브 뷰어 `viewer.html`(관전, `npm start`→localhost:8642/viewer.html). 공 구동은 Stage 3 전까지 placeholder(캐리어 드리블+파이널서드 턴오버).
- **Stage 3 — 공 소유·행동 ✅**: `js/game/ball.js`(공 물리: 마찰·포물선·득점판정) + `js/game/decide.js`(utility AI: 드리블/패스/스루/슛, 소유·컨트롤·가로채기·태클, GK 배급·선방, 득점·재개). 게이트 `sim/play-lint.mjs`(순간이동 없음·경계 안·양 팀 점유·패스/슛/탈취 발생·**방향 편향 없음**·재현성). **주의: 오프사이드 부재로 골이 실제보다 많다(≈26/경기)** — Stage 4 오프사이드 + Stage 8 튜닝에서 현실화. 알려진 임시: Stage3 재개는 마지막터치 반대팀 확정 지급(정식 스로인/골킥/코너 아님).
- **Stage 4 — 규칙**: 터치라인/골라인 아웃·스로인/골킥/코너·반칙/프리킥/PK·**오프사이드 스냅샷 판정(§10, 7사례 테스트)**·하프타임 교대·교체/카드/퇴장.
- **Stage 5 — 골키퍼**: 전용 상태/의사결정·캐치/펀치/패리·크로스/스루패스 판단·1대1·박스 손사용/백패스 규칙.
- **Stage 6 — 감독 카드(하이브리드, §12)**: CP 자원·덱/손패·validator·데이터 modifier system·일반 12+장·맥락 카드·타겟팅 UI. 카드는 AI utility/포지션/압박/위험감수에 실제 개입(장식 금지).
- **Stage 7 — 캡틴츠바사 연출**: 시네마틱 스테이지·대결 상태머신(결과는 시뮬이 먼저 계산)·전술 레이더 동기화·속도/일시정지.
- **Stage 8 — 테스트·튜닝**: 단위/통합·100경기 안정성(NaN·데드락·중복재개 0)·1280×720 UI·README.

## 7. 이번 저장소 기본값 (디자이너 이견 없으면 유지)

- 바닐라 JS 무빌드, 타입은 JSDoc + `tsc --checkJs`(선택). 더블클릭/`npm start` 실행 유지.
- 시간 압축 한 경기 ≈15분 · 교체 3명(클래식) · 1차엔 승부차기·연장 없이 무승부 허용.
- 개발 서버는 반드시 `tools/serve.py`(no-store) — http.server 캐시 함정 주의.

## 8. 열린 결정 (디자이너 대기)

- 관전 UX: 풀 경기 연속 관전 vs 결정적 순간 중심 하이라이트 확대(마스터 §8 "사소한 패스마다 컷신 금지"와 조율).
- 카드 경제: 마스터 §12 CP 풀세트 vs euclid 의 간소한 개입 모델 계승 — Stage 6 착수 전 확정.
- 난이도: 상대 감독 노이즈/반응시간/전술전환으로만 조절(스탯 사기 금지, §14).
- 킥오프 합법성(전원 자기 진영·상대 9.15m 이격)은 Stage 4 재개 규칙에서 처리. 현재 4-3-3 앵커는 공격수 3명이 상대 진영에서 시작(오픈플레이엔 정상, 킥오프 휘슬엔 압축 필요).
