// 카드/효과 엔진 게이트 (계획서 §12). S1: 효과 파이프라인(합성·만료·스택·결정론) 증명.
// 이후 슬라이스에서 카드 데이터·validator·덱/손패·맥락 카드 검증을 여기 확장한다.
//   node sim/cards-lint.mjs

import { readFileSync } from 'node:fs';
import { createMatch, tick, runToFulltime } from '../js/game/match.js';
import { resolve, resolvedFor, addEffect, stepEffects, stepResolve } from '../js/game/effects.js';
import { validateCard, deckCardById } from '../js/game/cards.js';
import { playFromHand, applyCard } from '../js/game/hand.js';
import { assignMarking } from '../js/game/defend.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));
const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// IN_PLAY 진입 + 최소 1틱 실행(clock>0)까지 — stepCards(ensureCards)가 돌아 state.cards 가 생기도록.
function toInPlay(s) { let n = 0; while ((s.phase !== 'IN_PLAY' || s.clockSeconds === 0) && n < 100) { tick(s); n++; } return s; }

console.log('1) 기본 resolve = 스탠스 미러 + 무효과 기본값');
{
  const s = toInPlay(createMatch(1, cfg));
  const r = resolve(s, 'A');
  ok(r.tactic === 'balanced' && r.lineHeight === 'mid' && r.press === 'normal' && r.attackZone === 'central', '스탠스 미러(balanced/mid/normal/central)');
  ok(near(r.shotBias, 1) && near(r.passBias, 1) && near(r.dribbleBias, 1) && near(r.throughBias, 1), 'MULTIPLY 키 기본=1');
  ok(r.commitForward === 0 && r.overlapSide === null && r.crossEarly === false && r.manMark === null, 'ADD/플래그 키 기본=0/null/false');
}

console.log('2) 스탠스 변경이 resolve 에 반영');
{
  const s = toInPlay(createMatch(1, cfg));
  s.tactics.A.tactic = 'attack'; s.tactics.A.lineHeight = 'high'; s.tactics.A.attackZone = 'wing';
  const r = resolve(s, 'A');
  ok(r.tactic === 'attack' && r.lineHeight === 'high' && r.attackZone === 'wing', 'tactics(스탠스) 반영');
}

console.log('3) 카드 효과 합성(MULTIPLY/ADD/OVERRIDE)');
{
  const s = toInPlay(createMatch(1, cfg));
  addEffect(s, 'A', { group: 'g_shot', mods: [{ key: 'shotBias', operation: 'MULTIPLY', value: 2 }], until: s.clockSeconds + 10 });
  addEffect(s, 'A', { group: 'g_commit', mods: [{ key: 'commitForward', operation: 'ADD', value: 3 }], until: s.clockSeconds + 10 });
  addEffect(s, 'A', { group: 'g_zone', mods: [{ key: 'attackZone', operation: 'OVERRIDE', value: 'wing_left' }], until: s.clockSeconds + 10 });
  stepResolve(s);
  const r = resolvedFor(s, 'A');
  ok(near(r.shotBias, 2), 'MULTIPLY shotBias→2');
  ok(r.commitForward === 3, 'ADD commitForward→3');
  ok(r.attackZone === 'wing_left', 'OVERRIDE attackZone→wing_left');
  ok(resolvedFor(s, 'B').shotBias === 1, '상대(B)는 영향 없음(팀 격리)');
}

console.log('4) 지속시간 만료 → 원복');
{
  const s = toInPlay(createMatch(1, cfg));
  addEffect(s, 'A', { group: 'g_shot', mods: [{ key: 'shotBias', operation: 'MULTIPLY', value: 3 }], until: s.clockSeconds + 10 });
  stepResolve(s); ok(near(resolvedFor(s, 'A').shotBias, 3), '적용 중 shotBias=3');
  s.effects.A[0].until = s.clockSeconds - 0.01;   // 과거로 만료
  stepEffects(s); stepResolve(s);
  ok(s.effects.A.length === 0 && near(resolvedFor(s, 'A').shotBias, 1), '만료 후 제거·shotBias 원복=1');
}

console.log('5) 스택 규칙(REFRESH/REJECT/REPLACE/STACK)');
{
  const s = toInPlay(createMatch(1, cfg));
  addEffect(s, 'A', { group: 'g', mods: [{ key: 'shotBias', operation: 'MULTIPLY', value: 2 }], until: 10, stacking: 'REFRESH' });
  const r2 = addEffect(s, 'A', { group: 'g', mods: [{ key: 'shotBias', operation: 'MULTIPLY', value: 2 }], until: 20, stacking: 'REFRESH' });
  ok(r2.refreshed && s.effects.A.length === 1 && s.effects.A[0].until === 20, 'REFRESH: 중복 없이 시간만 갱신');
  const rj = addEffect(s, 'A', { group: 'g', mods: [], until: 30, stacking: 'REJECT' });
  ok(!rj.ok && s.effects.A.length === 1, 'REJECT: 이미 활성이면 거부');
  addEffect(s, 'A', { group: 'g', mods: [{ key: 'passBias', operation: 'MULTIPLY', value: 5 }], until: 40, stacking: 'REPLACE' });
  stepResolve(s);
  ok(s.effects.A.length === 1 && near(resolvedFor(s, 'A').passBias, 5) && near(resolvedFor(s, 'A').shotBias, 1), 'REPLACE: 이전 그룹 효과 교체');
  addEffect(s, 'A', { group: 'g2', mods: [], until: 50, stacking: 'STACK' });
  ok(s.effects.A.length === 2, 'STACK/다른 그룹: 중첩');
}

console.log('6) 결정론 — 카드 미사용 시 같은 시드 동일 결과(회귀 방지)');
{
  const digest = (s) => `${s.score.A}-${s.score.B}|ev${s.eventLog.length}|bx${s.ball.position.x.toFixed(3)}|t${s.tickCount}`;
  const a = runToFulltime(createMatch(42, cfg));
  const b = runToFulltime(createMatch(42, cfg));
  ok(digest(a) === digest(b), `동일 (${digest(a)})`);
}

console.log('7) deck 스키마 (CoachCard §12)');
{
  const deck = cards.deck || [];
  ok(deck.length >= 12, `deck ${deck.length}장 (목표 ≥12)`);
  ok(deck.every((c) => c.id && c.name && typeof c.cost === 'number' && Array.isArray(c.timing) && Array.isArray(c.effects)),
    '모든 카드 필수 필드(id/name/cost/timing/effects)');
  ok(deck.every((c) => c.effects.every((e) => e.key && e.operation)), '모든 effect 에 key·operation');
  const validOps = new Set(['ADD', 'MULTIPLY', 'OVERRIDE']);
  ok(deck.every((c) => c.effects.every((e) => validOps.has(e.operation))), '모든 operation 이 ADD/MULTIPLY/OVERRIDE');
}

console.log('8) validateCard — 타이밍 & CP');
{
  const s = toInPlay(createMatch(3, cfg, null, cards)); s.cp = { A: 3, B: 3 };
  ok(validateCard(s, 'A', deckCardById(cards, 'high_press')).ok, 'high_press(ANYTIME,3) CP3 → 가능');
  s.cp.A = 2;
  const r = validateCard(s, 'A', deckCardById(cards, 'high_press'));
  ok(!r.ok && /CP/.test(r.reason), `CP 부족 거부 (${r.reason})`);
}

console.log('9) validateCard — 타이밍 불일치');
{
  const s = toInPlay(createMatch(4, cfg, null, cards)); s.cp = { A: 5, B: 5 };
  s.possessionTeamId = 'B';                                   // A 비소유 → IN_POSSESSION 카드 불가
  const r = validateCard(s, 'A', deckCardById(cards, 'long_shots'));
  ok(!r.ok && /타이밍/.test(r.reason), `타이밍 불가 (${r.reason})`);
  s.possessionTeamId = 'A';
  ok(validateCard(s, 'A', deckCardById(cards, 'long_shots')).ok, 'A 소유 시 long_shots 가능');
}

console.log('10) validateCard — 전제조건(침투 패스: 온사이드 침투자)');
{
  const s = toInPlay(createMatch(5, cfg, null, cards)); s.cp = { A: 5, B: 5 }; s.possessionTeamId = 'A';
  const card = deckCardById(cards, 'through_pass');
  s.ball.position = { x: 40, y: 0, z: 0 };                    // A는 +x 공격
  for (const p of Object.values(s.players)) if (p.teamId === 'A' && p.role !== 'GK') p.position.x = 25;  // 전원 공 뒤
  const bOut = Object.values(s.players).filter((p) => p.teamId === 'B' && p.role !== 'GK');
  bOut[0].position.x = 62; bOut[1].position.x = 60;           // 세컨드-라스트 라인 = 60
  const rNo = validateCard(s, 'A', card);
  ok(!rNo.ok && /침투자/.test(rNo.reason), `침투자 없음 → 거부 (${rNo.reason})`);
  const runner = Object.values(s.players).find((p) => p.teamId === 'A' && p.role !== 'GK');
  runner.position.x = 55; runner.position.z = 5;              // 공 앞·오프사이드 라인(60) 안쪽 = 온사이드
  ok(validateCard(s, 'A', card).ok, '온사이드 침투자 존재 → 가능');
}

console.log('11) validateCard — 타겟(밀착 마크: 상대 선수)');
{
  const s = toInPlay(createMatch(6, cfg, null, cards)); s.cp = { A: 5, B: 5 };
  const mm = deckCardById(cards, 'man_mark');
  ok(!validateCard(s, 'A', mm, null).ok, '타겟 없음 → 거부');
  ok(!validateCard(s, 'A', mm, 'A5').ok, '아군 지정 → 거부(상대 대상 카드)');
  ok(validateCard(s, 'A', mm, 'B5').ok, '상대 선수 지정 → 가능');
}

console.log('12) validateCard — 쿨다운');
{
  const s = toInPlay(createMatch(7, cfg, null, cards)); s.cp = { A: 5, B: 5 };
  const hp = deckCardById(cards, 'high_press');              // cooldownGroup 'line'
  s.cardCooldowns = { A: { line: s.clockSeconds + 10 }, B: {} };
  const r = validateCard(s, 'A', hp);
  ok(!r.ok && /대기/.test(r.reason), `쿨다운 거부 (${r.reason})`);
  s.cardCooldowns.A.line = s.clockSeconds - 1;
  ok(validateCard(s, 'A', hp).ok, '쿨다운 경과 후 가능');
}

console.log('13) 덱/손패 초기화 · 카드 보존 불변식');
{
  const s = toInPlay(createMatch(10, cfg, null, cards));
  const cc = s.cards.A;
  ok(cc && cc.hand.length >= 3 && cc.hand.length <= cards.draw.handMax, `시작 손패 ${cc.hand.length}장 (≤${cards.draw.handMax})`);
  ok(cc.deck.length + cc.hand.length + cc.discard.length === (cards.deck.length), '덱+손패+버림 = 총 카드수(보존)');
  ok(!!s.cardRng && s.cp.A != null && s.cp.B != null, 'cardRng·양 팀 CP 초기화');
}

console.log('14) playFromHand → 전달중 → 도착 → 효과 발동');
{
  const s = toInPlay(createMatch(11, cfg, null, cards)); s.cp.A = 3;
  s.cards.A.hand = [{ id: 'high_press', card: deckCardById(cards, 'high_press'), drawnAt: s.clockSeconds }];
  const r = playFromHand(s, 'A', 0, null, cards);
  ok(r.ok, 'high_press 플레이 성공');
  ok(s.pending.A && s.pending.A.card.id === 'high_press', '전달중(pending)에 등록');
  ok(s.cp.A === 0, `CP 차감 3→0 (실제 ${s.cp.A})`);
  for (let i = 0; i < 45; i++) tick(s);                       // 전달(2s) 경과
  ok(s.effects.A.some((e) => e.id === 'high_press'), '도착 후 효과 활성');
  const R = resolvedFor(s, 'A');
  ok(R.press === 'high' && R.lineHeight === 'high', 'resolve 에 press=high·line=high 반영');
  ok(s.cards.A.discard.includes('high_press'), '사용 카드 버림더미로');
}

console.log('15) 오디블 — 전달 중 교체 + CP 재정산');
{
  const s = toInPlay(createMatch(12, cfg, null, cards)); s.cp.A = 5;
  s.cards.A.hand = [
    { id: 'high_press', card: deckCardById(cards, 'high_press'), drawnAt: 0 },  // cost 3
    { id: 'slow_tempo', card: deckCardById(cards, 'slow_tempo'), drawnAt: 0 },  // cost 1
  ];
  playFromHand(s, 'A', 0, null, cards);                        // high_press 전달중, CP 5→2
  ok(s.cp.A === 2, `첫 플레이 CP 5→2 (${s.cp.A})`);
  const r = playFromHand(s, 'A', 0, null, cards);              // 남은 slow_tempo 를 오디블
  ok(r.ok && r.audible, '오디블 성공');
  ok(s.pending.A.card.id === 'slow_tempo', '전달중 카드 교체됨');
  ok(s.cp.A === 4, `CP 재정산 2+환불3−1=4 (${s.cp.A})`);
  ok(s.cards.A.hand.some((x) => x.id === 'high_press'), '이전 전달중 카드 손패 복귀');
}

console.log('16) 상대(B) 카드 AI(김성주 예고→적용) + 카드 포함 결정론');
{
  const full = (seed) => { const s = createMatch(seed, cfg, null, cards); while (s.phase !== 'FULLTIME') tick(s); return s; };
  const a = full(20);
  const sigT = a.eventLog.filter((e) => e.type === 'SIGNAL' && e.telegraph).length;
  const sigA = a.eventLog.filter((e) => e.type === 'SIGNAL' && e.applied).length;
  ok(sigT > 0 && sigA > 0, `상대 카드: 예고 ${sigT}회·적용 ${sigA}회`);
  const dg = (s) => `${s.score.A}-${s.score.B}|ev${s.eventLog.length}|cr${s.cardRng.state}|bx${s.ball.position.x.toFixed(2)}`;
  const b = full(20);
  ok(dg(a) === dg(b), `카드 포함 결정론 동일 (${dg(a)})`);
}

console.log('17) 카드 효과가 실제 포지셔닝에 반영 — 밀착 마크(manMark)');
{
  const s = toInPlay(createMatch(30, cfg, null, cards));
  s.possessionTeamId = 'B';                                   // A 수비(A 공격 방향 +x → 자기 골 −x)
  const b9 = s.players.B9; b9.position = { x: -30, z: 6 };    // A 진영의 위협
  const marksNo = assignMarking(s, 'A', null, null);
  const nearNo = Object.values(marksNo).some((m) => Math.hypot(m.x - b9.position.x, m.z - b9.position.z) < 2.0);
  applyCard(s, 'A', deckCardById(cards, 'man_mark'), 'B9'); stepResolve(s);
  ok(resolvedFor(s, 'A').manMark === 'B9', 'resolve.manMark = B9');
  const marks = assignMarking(s, 'A', null, null);
  const near = Object.values(marks).some((m) => Math.hypot(m.x - b9.position.x, m.z - b9.position.z) < 2.0);
  ok(Object.keys(marks).length > 0 && near, '지정 마크 시 B9 를 밀착(목표가 B9 인근 <2m)');
  ok(!nearNo || near, '카드 전/후 마킹 동작(회귀 아님)');
}

console.log('18) 키 소비 회귀 — 카드 미사용 시 baseline digest 불변(identity)');
{
  const digest = (s) => `${s.score.A}-${s.score.B}|ev${s.eventLog.length}|bx${s.ball.position.x.toFixed(3)}`;
  const a = runToFulltime(createMatch(42, cfg));               // 카드 없음
  ok(digest(a) === '4-5|ev1704|bx-50.802', `baseline 불변 (${digest(a)})`);
}

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 있음'}  (pass ${pass}, fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
