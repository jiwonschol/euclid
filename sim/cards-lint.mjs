// 카드/효과 엔진 게이트 (계획서 §12). S1: 효과 파이프라인(합성·만료·스택·결정론) 증명.
// 이후 슬라이스에서 카드 데이터·validator·덱/손패·맥락 카드 검증을 여기 확장한다.
//   node sim/cards-lint.mjs

import { readFileSync } from 'node:fs';
import { createMatch, tick, runToFulltime } from '../js/game/match.js';
import { resolve, resolvedFor, addEffect, stepEffects, stepResolve } from '../js/game/effects.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

function toInPlay(s) { let n = 0; while (s.phase !== 'IN_PLAY' && n < 100) { tick(s); n++; } return s; }

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

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 있음'}  (pass ${pass}, fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
