// 감독 스탠스 카드 게이트 (디자이너 2026-07-15 재정의).
// 이 게임의 문법을 잠근다: 카드가 '들어가고' 결과가 바뀐다 · 빌드업/하이라이트 분리 · 참모가 개입한다.
//   node sim/stance-lint.mjs   (npm run sim:stance)

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { selectStance, acceptAdvice, playSub, threatMul } from '../js/game/stance.js';
import { resolvedFor } from '../js/game/effects.js';

const L = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url)));
const cfg = L('engine.json'), com = L('commentary.json'), stc = L('stance.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const mk = (seed = 3) => { const s = createMatch(seed, cfg, com, stc); for (let i = 0; i < 400; i++) tick(s); return s; };
const run = (s, n) => { for (let i = 0; i < n; i++) tick(s); };

console.log('감독 스탠스 카드 게이트\n');

console.log('1) 기본값은 모든 그룹이 밸런스 (유저가 아무것도 안 해도 경기는 돈다)');
{
  const s = mk();
  ok(stc.groups.every((g) => s.stance.A[g.id] === 'balance'), `${stc.groups.length}개 그룹 전부 balance 기본`);
  ok(stc.groups.every((g) => g.options.length === 3 && g.options[0].id === 'balance'),
    '각 그룹 = 3열(밸런스 + 상반 2개)');
  ok(!('cp' in s) && !('deck' in s) && !('hand' in s), 'CP·덱·손패 개념 없음(복잡도 제거)');
}

console.log('\n2) 카드가 실제로 들어간다: 선택 → 전달 중 → 도착 → resolve 변화');
{
  const s = mk();
  ok(resolvedFor(s, 'A').defendZone === 'balance', '적용 전 resolve.defendZone = balance');
  const r = selectStance(s, 'A', 'defend_zone', 'wing', stc);
  ok(r.ok && s.pending.A && s.pending.A.option === 'wing', '선택 → 전달 중(pending) 등록');
  ok(resolvedFor(s, 'A').defendZone === 'balance', '전달 중엔 아직 미반영(즉시 반영 아님)');
  run(s, 40);
  ok(s.stance.A.defend_zone === 'wing', '전달 시간 후 도착 → stance 반영');
  ok(resolvedFor(s, 'A').defendZone === 'wing', '도착 → resolve.defendZone = wing (엔진이 읽는 값)');
  const ev = s.eventLog.map((e) => e.type);
  ok(ev.includes('STANCE_PENDING') && ev.includes('STANCE_ARRIVED'), '전달중·도착 이벤트 로그');
}

console.log('\n3) 오디블: 중계를 보고 상반된 선택으로 바꿀 수 있다');
{
  const s = mk();
  selectStance(s, 'A', 'line', 'up', stc);
  const r2 = selectStance(s, 'A', 'line', 'down', stc);      // 전달 중 반대 선택
  ok(r2.ok && r2.audible, '전달 중 반대 카드 → 오디블');
  run(s, 40);
  ok(s.stance.A.line === 'down', '마지막 선택만 반영(라인 내리기)');
  ok(resolvedFor(s, 'A').lineHeight === 'low', 'resolve.lineHeight = low');
}

console.log('\n4) 한 그룹엔 하나만 활성 (상반 개념이 동시에 켜지지 않음)');
{
  const s = mk();
  selectStance(s, 'A', 'press', 'high', stc); run(s, 40);
  ok(resolvedFor(s, 'A').pressAggression > 1.2, '높은 압박 → pressAggression↑');
  selectStance(s, 'A', 'press', 'low', stc); run(s, 40);
  const R = resolvedFor(s, 'A');
  ok(R.pressAggression < 0.8, '낮은 압박으로 교체 → pressAggression↓ (중첩 아님)');
  ok(s.effects.A.filter((e) => e.group === 'press').length === 1, 'press 그룹 활성 효과 1개(REPLACE)');
}

console.log('\n5) 읽고 대응: 수비 방향 vs 실제 위협 → 확률이 바뀐다 (핵심 문법)');
{
  const s = mk();
  selectStance(s, 'A', 'defend_zone', 'wing', stc); run(s, 40);
  s.seq.threat = 'wing';
  const hit = threatMul(s, 'A', stc);
  s.seq.threat = 'central';
  const miss = threatMul(s, 'A', stc);
  selectStance(s, 'A', 'defend_zone', 'balance', stc); run(s, 40);
  const bal = threatMul(s, 'A', stc);
  ok(hit > bal && bal > miss, `맞힘 ${hit} > 밸런스 ${bal} > 빗나감 ${miss}`);
  ok(hit === stc.matchup.hit && miss === stc.matchup.miss, '매치업 배수가 데이터(stance.json)에서 온다');
}

console.log('\n6) 빌드업/하이라이트 분리 — 의미 없는 플레이는 바둑알로 재생하지 않는다');
{
  const s = mk(5);
  let bu = 0, hl = 0;
  for (let i = 0; i < 30000; i++) { tick(s); if (s.phase !== 'IN_PLAY') continue; s.seq.mode === 'HIGHLIGHT' ? hl++ : bu++; }
  const pct = 100 * bu / (bu + hl);
  ok(bu > 0 && hl > 0, `두 모드 모두 발생 (빌드업 ${pct.toFixed(0)}% / 하이라이트 ${(100 - pct).toFixed(0)}%)`);
  ok(pct > 20, '빌드업이 충분히 존재 = 유저가 반응할 시간이 있다');
  ok(s.eventLog.some((e) => e.type === 'HIGHLIGHT_START'), '하이라이트 시작 이벤트');
}

console.log('\n7) 참모: 직접적인 정보 + 받아들이면 그대로 적용');
{
  const s = mk(7);
  run(s, 20000);
  const adv = s.eventLog.filter((e) => e.type === 'ADVICE');
  ok(adv.length >= 12, `참모가 계속 개입한다 (${adv.length}회, 실시간 ~10초당 1회) — 영구 dedupe 였을 땐 2회뿐이었다`);
  ok(adv.every((e) => e.group && e.option), '모든 조언이 실행 가능한 스탠스를 제안');
  // 조언 받아들이기 → 그 스탠스가 그대로 들어간다
  let took = false;
  for (let i = 0; i < 4000 && !took; i++) {
    tick(s);
    if (s.advice) { const sug = { ...s.advice.suggest }; const r = acceptAdvice(s, stc); if (r.ok) { run(s, 40); ok(s.stance.A[sug.group] === sug.option, `조언(${sug.group}=${sug.option})이 그대로 적용됨`); took = true; } }
  }
  ok(took, '참모 조언 수락 경로 동작');
}

console.log('\n8) 교체: 3장 · 역할별 확률↑ · 0%는 가능하되 음수는 불가 · 결과를 알린다');
{
  const s = mk(11);
  ok(s.subs.A.left === stc.subs.limit, `교체 자원 ${stc.subs.limit}장`);
  const before = resolvedFor(s, 'A').shotBias;
  const r = playSub(s, 'fw', stc);
  ok(r.ok && r.boost >= 0, `공격수 투입 boost=${(r.boost * 100).toFixed(0)}% (음수 불가)`);
  ok(r.boost <= stc.subs.maxBoost, `boost ≤ maxBoost(${stc.subs.maxBoost})`);
  ok(resolvedFor(s, 'A').shotBias >= before, '투입 → shotBias 상승(감소 없음)');
  ok(s.subs.A.left === stc.subs.limit - 1, '자원 1장 소모');
  playSub(s, 'mf', stc); playSub(s, 'df', stc);
  ok(!playSub(s, 'fw', stc).ok, '3장 소진 후 불가');
  run(s, 12000);
  ok(s.eventLog.some((e) => e.type === 'SUB_REPORT'), '투입 후 시퀀스에서 결과를 알린다(다음 시퀀스로 못 박지 않음)');
}

console.log('\n9) 상대도 같은 스탠스 시스템 + 결정론');
{
  const s = mk(13); run(s, 20000);
  ok(s.eventLog.some((e) => e.type === 'OPP_STANCE'), '상대(인천)가 스탠스를 바꾼다');
  const dig = (x) => `${x.score.A}-${x.score.B}|${x.eventLog.length}`;
  const a = createMatch(21, cfg, com, stc), b = createMatch(21, cfg, com, stc);
  for (const x of [a, b]) for (let i = 0; i < 6000; i++) { tick(x); if (x.tickCount === 300) selectStance(x, 'A', 'mentality', 'all_out', stc); }
  ok(dig(a) === dig(b), `같은 시드 + 같은 카드 → 같은 결과 (${dig(a)})`);
}

console.log('\n10) 중계가 카드를 말한다 (텍스트가 코어)');
{
  const s = mk(17);
  selectStance(s, 'A', 'defend_zone', 'wing', stc); run(s, 60);
  const f = s.feed.map((x) => x.text);
  ok(f.some((t) => /전달 중/.test(t)), '전달 중 중계');
  ok(f.some((t) => /지시 도착/.test(t)), '도착 중계');
  run(s, 8000);
  const f2 = s.feed.map((x) => x.text);
  ok(f2.some((t) => /🔍/.test(t)), '빌드업 힌트 중계(유저가 읽고 반응할 근거)');
}

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 있음'}  (pass ${pass}, fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
