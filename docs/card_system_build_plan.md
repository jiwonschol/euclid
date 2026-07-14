# 하스스톤형 감독 카드 시스템 — 자율 빌드 플랜 (living doc)

> 이 문서는 ralph-loop의 **지속 메모리**다. 매 반복(iteration)마다: ① 이 문서를 읽고 ② 다음 미완 슬라이스를 골라 ③ 구현하고 ④ **헤드리스 게이트 + live 브라우저**로 검증하고 ⑤ 체크박스/로그를 갱신하고 ⑥ 커밋한다. 압축(compaction) 이후에도 이 문서만 읽으면 이어서 할 수 있어야 한다.

## 목표 (한 문단)
계획서 `docs/captain_tsubasa_card_manager_claude_code_prompt.md` **§12(감독 카드 하이브리드)**를 이 저장소(vanilla JS ES module, 연속 경기 엔진 `js/game/`)에 실제 구현한다. 현재의 "고정 11장 지시 팔레트"를 **하스스톤 형태의 카드 게임**으로 진화시킨다: 덱에서 뽑는 손패, CP 경제, timing/target을 가진 `CoachCard`, **데이터 기반 `TacticalModifier`(scattered if문 금지)**, 12장 이상 일반 카드, 큰 순간의 맥락(context) 카드, 정확한 실패 사유를 주는 validator, 지속시간·쿨다운. 상대(B)도 같은 카드/효과 시스템으로 두어 "읽고 대응하는" 루프를 완성한다.

## 절대 원칙 (Non-negotiables)
1. **live 브라우저 검증이 진짜 게이트다.** 헤드리스 sim 수치만 믿지 않는다(과거 실패 원인). 매 UI 관련 슬라이스는 `localhost:8642/viewer.html`를 열고 `window.__dbg.state()`로 상태를, DOM/스크린샷으로 표현을 확인한다. 콘솔 에러 0.
2. **결정론 유지.** 엔진은 `Math.random`/`Date` 금지, `state.rng`만. 카드 UI/포지셔닝/중계는 `state.rng`를 소비하면 안 된다(재현성 게이트). 상대 AI 판단만 rng 소비 허용.
3. **기존 게이트를 깨지 않는다.** `sim:match/pos/play/seq/stability`는 카드 미사용 시 기존과 동일하게 통과해야 한다(패스 분포 10/40/30 목표 편차 ≤8%p 유지). 카드 효과는 기본값이 곧 현재 동작.
4. **데이터 기반 modifier.** 카드별 `if`문을 decide/ai/viewer에 흩뿌리지 않는다. 카드 → `TacticalModifier[]` → effect engine이 `resolve(state,team)`로 합성 → AI가 resolved 값을 읽는다.
5. **기본 축구를 잠그지 않는다.** 손패에 카드가 없어도 선수는 패스·드리블·슛·수비를 한다. 카드는 확률/우선순위/포지셔닝/위험감수만 바꾼다.
6. **커밋은 작고 자주.** 각 슬라이스 = 1커밋 이상. 한국어 커밋 메시지. 브랜치 `feature/continuous-match-engine`.

## 아키텍처 (파일과 책임)
- `js/game/effects.js` **(신규)** — 효과 엔진. `state.effects.{A,B}: ActiveEffect[]`. `applyCard(state,team,card,target)`, `stepEffects(state,dt)`(지속시간 만료), `resolve(state,team) → ResolvedTactics`(base 스탠스 + 활성 modifier 합성; stacking 규칙 REPLACE/REFRESH/STACK/REJECT). **modifier key registry는 아래.**
- `js/game/cards.js` **(신규)** — 카드 도메인. `validateCard(state,team,card,target) → {ok,reason}`(검증 순서 §12), 덱/손패/드로우(`state.deck/hand`), `playFromHand`, `drawUpTo`, `swapStale`. 맥락 카드 주입 `offerContext(state,team,kind)`.
- `js/game/directives.js` **(개편)** — 유저(A) 카드 플레이 진입점을 cards.js/effects.js로 위임. `stepOpponentAI`는 B가 같은 카드 시스템으로 카드를 내도록(김성주 telegraph 유지).
- `js/game/decide.js` / `shape.js` / `attack.js` / `defend.js` / `ai.js` **(리팩터)** — raw `state.tactics` 대신 `resolve(state,team)`의 값을 읽는다. 기본값 == 현재 동작(게이트 불변).
- `data/cards.json` **(재작성)** — `CoachCard` 스키마 16장 + 맥락 카드 정의 + CP/덱/드로우 파라미터 + opponentAI 정책.
- `viewer.html` **(개편)** — 부채꼴 손패(드로우된 카드), 비용/이름/효과/지속, 사용가능 강조 vs 불가 흐림+사유 툴팁, 타겟팅(선수/존/상대), 활성효과 칩+잔여시간, 맥락 카드 팝업, 이벤트 로그, 속도/일시정지.
- `sim/cards-lint.mjs` **(신규)** — 카드 헤드리스 검증: 각 카드가 AI 가중치를 바꾸는지, 지속시간 만료, stacking, precondition 게이팅, CP 차감/환불, 결정론(같은 시드+카드로그 → 동일 결과).

### Modifier key registry (effects.js resolve()의 출력 키; 기본값 = 현재 동작)
| key | scope | 의미 / 엔진 연결 | 기본값 |
|---|---|---|---|
| `stance` | TEAM | 'balanced'\|'attack'\|'counter'\|'park' 기본 스탠스 | 'balanced' |
| `lineHeight` | TEAM | 'low'\|'mid'\|'high' 수비 라인 | 'mid' |
| `pressAggression` | TEAM | 압박 강도(최대 압박 인원·engageDist). 1=기본 | 1.0 |
| `attackZone` | TEAM | 'central'\|'wing-left'\|'wing-right'\|'balanced' | 'central' |
| `shotBias` | TEAM | 슛 효용/거리 배수(중거리 허용) | 1.0 |
| `dribbleBias` | TEAM | wDribble 배수(개인기 중심) | 1.0 |
| `passBias` | TEAM | wPass 배수(패스워크 중심) | 1.0 |
| `throughBias` | TEAM | 스루패스 효용 배수(침투 패스) | 1.0 |
| `tempo` | TEAM | 안전패스·볼유지 성향(템포 낮추기). 1=기본, <1=느림 | 1.0 |
| `crossEarly` | TEAM | 이른 크로스 우선(빠른 크로스) | false |
| `overlapSide` | TEAM | null\|'left'\|'right' 풀백 오버랩+윙어 안쪽 | null |
| `switchNext` | NEXT_ACTION | 다음 소유행동 롱대각(측면 전환) | false |
| `transition` | TEAM | 'counterPress'\|'recover'\|null 수비전환 반응 | null |
| `commitForward` | TEAM | 전진 투입 인원 가산(전원 공격). 최소 2+GK 잔류 불변 | 0 |
| `manMark` | PLAYER | {defenderId?,targetId} 밀착 마크 | null |
| `gutsThresh` | TEAM | 특수기술 임계 배수(거츠 절약↑/적극↓). (특수기술은 후속) | 1.0 |
| `nextAction` | NEXT_ACTION | 맥락카드: 'shot'\|'through'\|'oneTwo'\|'safe'\|'tackle'\|'block'\|'jockey' 보정 | null |

## 슬라이스 (각 슬라이스 DoD = 헤드리스 통과 + 해당되면 브라우저 확인 + 커밋)
- [x] **S1 · 효과 엔진 코어(헤드리스)** — `effects.js`: `state.effects`, `resolve()`(기본값=현재), `stepEffects` 만료, `addEffect` 스택규칙, `consumeNextAction`. decide/ai/attack를 `resolvedFor()` 경유로 리팩터(shot/pass/dribble/through에 ×1.0 identity 주입점). match.tick에 stepEffects+stepResolve. **게이트 통과(동작 불변) + 브라우저 검증 완료.** 커밋.
- [x] **S2 · CoachCard 데이터 + validator** — `data/cards.json` 에 `deck`(16장 CoachCard)+`context`(맥락)+`draw` 파라미터 추가(레거시 `cards`/CP/opponentAI 유지 → 뷰어 무손상). `cards.js`: matchTimings(타이밍 판정), validateCard(타이밍→CP→타겟→전제조건→쿨다운, 정확 사유), PRECONDS(onsideRunner/boxTargets). decide.gainControl 에 `_possChangedAt`(전환 타이밍). 헤드리스 30/30 + 브라우저 무손상 확인. 커밋.
- [x] **S3 · 덱·손패·드로우 + 뷰어 컷오버** — `js/game/hand.js` 신규: 덱/손패/드로우(cardRng 분리), playFromHand(검증→전달중→도착 applyCard→버림), 오디블(CP 재정산), playSub, 상대 B 카드 AI(김성주 예고→적용). match.tick 이 stepCards 로 전환, 레거시 directives.js **삭제**. 뷰어를 드로우된 손패+활성효과+전달중+교체 UI로 개편(playDirective→playFromHand). sim:cards 46/46(플레이/오디블/상대AI/카드결정론). **브라우저 E2E**: 손패 렌더·slow_tempo 플레이→전달중→도착→resolve(tempo0.7·pass1.15·shot0.85)·중계 서사·상대 카드 동작. 커밋.
- [x] **S4a · 남은 modifier 키를 엔진에 연결** — manMark(defend.js 지정 밀착), pressAggression(ai.js 압박 개시거리), tempo(decide 전진성향↓), crossEarly(decide 이른 크로스), wing_left/right(decide wingSide). 모두 기본값 identity. **버그 발견·수정: defaults()에 pressAggression 누락→NaN→압박 무력화**(golden-digest 회귀가 포착). sim:cards 50/50(manMark 포지셔닝 + baseline 불변). 브라우저 헬스(22 유한·pressAgg=1). 커밋. 남은 미연결: commitForward·transition(경미).
- [x] **S4 · 맥락(context) 카드 / 큰 순간** — decide 에 NEXT_ACTION 소비(측면전환·맥락 편향 후 1회 소비). hand.js offerContext: 볼소유 대결(파이널서드+압박) 감지→맥락 카드 4종 주입(즉시 적용·전달중 없음)·4.5초 창·만료 제거·스로틀. 뷰어 맥락 카드 금색 스타일(⚡맥락·즉시). sim:cards 57/57(소비·주입·즉시적용·만료). **브라우저**: live 엔진 맥락 주입(드리블강행/안전패스/원투/즉시슛)·금색 렌더·불가카드 회색+사유. 커밋.
- [~] **S5 · 뷰어 UI 폴리시** — (기본 손패/효과칩/전달중/교체/불가사유 툴팁은 S3 컷오버에서 완료). 남은 것: **부채꼴 hover 확대**, **클릭 타겟팅**(man_mark 선수 지정 — 현재 자동), 맥락 카드 팝업(S4 연동), modifier 시각 피드백 강화. 브라우저 검증.
- [ ] **S6 · 테스트·게이트·안정성** — cards-lint 확장(stacking/precondition/결정론), `sim:stability` 100경기(예외·NaN·deadlock·중복재개 0). 전 게이트 green. 커밋.
- [ ] **S7 · 브라우저 E2E + 폴리시 + README** — 시나리오(상대 telegraph→유저 대응 카드→효과 반영)를 브라우저로 재현·스크린샷, README 카드 사용법. 커밋.

## 게이트 명령
```
npm run sim:match      # 경기 골격·시계 무결성
npm run sim:pos        # 속도캡·재현성
npm run sim:play       # 완주·NaN·방향편향
npm run sim:seq        # 패스 시퀀스 분포(10/40/30, 편차 ≤8%p)  [느림 ~30경기]
npm run sim:stability  # 100경기 안정성  [느림]
node sim/cards-lint.mjs   # (신규) 카드/효과/결정론
```
브라우저: `preview_start(name:"euclid-proto")` → `navigate localhost:8642/viewer.html` → `read_console_messages(onlyErrors)` + `javascript_tool(window.__dbg.state())` + `computer screenshot`.

## 완료 조건 (completion promise = `EUCLID_CARDS_SHIPPED_AND_BROWSER_VERIFIED`)
S1~S7 전부 체크 && 전 헤드리스 게이트 green && 브라우저에서 (a)뷰어 콘솔 에러 0, (b)드로우된 손패 렌더, (c)카드 플레이가 `state.effects`/`resolve()`를 실제로 바꾸고 AI 동작/포지션에 반영, (d)불가 카드가 사유 표시, (e)상대 telegraph→유저 대응 루프 동작 — 을 **직접 확인**했을 때에만 promise 출력.

## 반복 로그 (append-only; 최신이 위)
- **iter4 · S4a+S4 완료** — S4a: 남은 modifier 키(manMark/pressAggression/tempo/crossEarly/wing_left·right) 엔진 연결 + pressAggression defaults 누락 NaN 버그 수정(golden-digest 포착). S4: decide NEXT_ACTION 소비 + hand.offerContext(볼소유 대결 감지→맥락 카드 주입/즉시적용/만료). 뷰어 맥락 금색 스타일. sim:cards 57/57, baseline identity 불변, stability 100/100(S4a). 브라우저: 맥락 카드 live 주입·렌더·불가사유 회색 확인. 남은=S5 폴리시(부채꼴/클릭타겟팅)·S7 README.
- **iter3 · S3 완료(+뷰어 컷오버)** — `js/game/hand.js`(덱/손패/드로우·playFromHand·오디블·playSub·상대 카드 AI, cardRng 시뮬 분리). match.tick→stepCards, directives.js 삭제. cards.validateCard 에 cpBonus(오디블). cards.json draw.deliverySec. 뷰어 전면 개편(드로우 손패·활성효과 칩·전달중·교체·불가사유 툴팁). stability.mjs 를 새 API로 이관. 게이트 sim:cards 46/46. **브라우저 E2E 완전 검증**(스크린샷: 6장 손패·중계 서사·상대 카드). S5는 폴리시(부채꼴/타겟팅)만 남음. 다음=S4(맥락 카드) 또는 S6(stability 100경기).
- **iter2 · S2 완료** — `data/cards.json`: deck 16 CoachCard(effects=TacticalModifier[])+context 3종(BALL_CARRIER_DUEL/DEFENSIVE_DUEL/GK 1대1)+draw 파라미터, 레거시 cards 유지(high_press→high_press_legacy 리네임으로 id 충돌 회피). `js/game/cards.js` 신규: matchTimings/validateCard/PRECONDS. decide.gainControl 에 `_possChangedAt`(전환 타이밍, determinism-safe). 게이트: sim:cards 30/30, 결정론 digest 불변(4-5|ev1704). 브라우저: 콘솔0·deck16/context/draw 파싱·레거시 손패11 정상 플레이(balanced→pending). 다음=S3(덱·손패·드로우+playFromHand+상대 AI).
- **iter1 · S1 완료** — `js/game/effects.js` 신규(resolve/stepEffects/stepResolve/addEffect/consumeNextAction, modifier registry 17키). match.js(effects/resolved 상태 + tick 훅), ai/attack/decide를 resolvedFor 경유로 라우팅 + decide에 shot/pass/dribble/through ×bias(기본 1.0) 주입점. 게이트: sim:cards 15/15 ✓, sim:match/pos/play 베이스라인과 동일(play 합 57, pos 900건, 재현성 OK). **브라우저 검증**: viewer 콘솔0, state.effects/resolved 채워짐, live 엔진에 효과 주입 시 resolve가 반영(shotBias 1→2.5→1)·만료 원복 확인. 다음=S2(CoachCard 데이터+validator).
- iter0 · 베이스라인 green: sim:match/pos/play ✓, viewer.html live 정상(콘솔0, __dbg 동작). 브랜치 feature/continuous-match-engine @ 618e89e.
