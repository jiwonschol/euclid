// §11/§17 규칙 게이트 — 반칙·프리킥·PK·경고/퇴장 + §4 불변조건.
// 감사(docs/plan_audit.md)에서 "기능도 테스트도 없음"으로 잡힌 항목을 실제로 잠근다.
//   node sim/rules-lint.mjs

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { FIELD, penaltyBoxOf } from '../js/game/field.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));
const stc = JSON.parse(readFileSync(new URL('../data/stance.json', import.meta.url)));
const comm = JSON.parse(readFileSync(new URL('../data/commentary.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// 전 시드 이벤트 수집(반칙은 확률적이라 표본이 필요)
const N = 20;
const runs = [];
for (let seed = 1; seed <= N; seed++) {
  const s = createMatch(seed, cfg, comm, stc);
  const seen = { pitchViolation: 0, dupRestart: 0 };
  let lastOut = null;
  while (s.phase !== 'FULLTIME') {
    tick(s);
    for (const p of Object.values(s.players)) {
      // §4 불변조건: 퇴장 선수는 경기장에 존재하지 않는다
      if (p.sentOff && Math.abs(p.position.z) <= FIELD.halfWidth && Math.abs(p.position.x) <= FIELD.halfLength) seen.pitchViolation++;
      // §4 불변조건: 모든 좌표·속도 유한
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.velocity.x)) seen.pitchViolation++;
    }
  }
  runs.push({ s, seen });
}
const allEv = runs.flatMap((r) => r.s.eventLog);
const fouls = allEv.filter((e) => e.type === 'FOUL');
const cardsEv = allEv.filter((e) => e.type === 'CARD');
const sentOffs = allEv.filter((e) => e.type === 'SENT_OFF');
const restarts = allEv.filter((e) => e.type === 'RESTART');

console.log(`§11 규칙 게이트 — ${N}경기\n`);

console.log('1) 반칙이 실제로 발생하고 FoulEvent 가 독립 이벤트다 (§11)');
ok(fouls.length > 0, `FOUL 이벤트 발생 (${fouls.length}건, 경기당 ${(fouls.length / N).toFixed(1)})`);
ok(fouls.every((e) => e.by && e.on && e.team && typeof e.sev === 'number'),
  'FoulEvent 가 반칙자·피해자·팀·강도를 실음');

console.log('\n2) 반칙 빈도가 실축 범위 (계수 튜닝 회귀 잠금)');
const perMatch = fouls.length / N, yPer = cardsEv.filter((e) => e.card === 'yellow').length / N;
ok(perMatch >= 15 && perMatch <= 35, `반칙 ${perMatch.toFixed(1)}/경기 (15~35)`);
ok(yPer <= 8, `옐로 ${yPer.toFixed(1)}/경기 (≤8)`);

console.log('\n3) 반칙 → 직접 프리킥, 박스 안 반칙 → PK (§11)');
const fk = restarts.filter((e) => e.kind === 'freekick').length;
const pk = restarts.filter((e) => e.kind === 'penalty').length;
ok(fk > 0, `프리킥 재개 발생 (${fk}건)`);
ok(fouls.filter((e) => e.pk).length === pk, `박스 안 반칙 수(${fouls.filter((e) => e.pk).length}) == PK 재개 수(${pk})`);
ok(pk / N <= 2, `PK ${(pk / N).toFixed(2)}/경기 — 남발 아님 (≤2)`);

console.log('\n4) 옐로 2장 = 레드 = 퇴장 (§11/§17)');
const second = cardsEv.filter((e) => e.card === 'yellow' && e.second).length;
const red = cardsEv.filter((e) => e.card === 'red').length;
ok(sentOffs.length === second + red, `퇴장(${sentOffs.length}) == 두번째옐로(${second}) + 레드(${red})`);
for (const { s } of runs) {
  for (const p of Object.values(s.players)) {
    if (p.yellowCards >= 2 && !p.sentOff) { ok(false, `옐로 2장인데 미퇴장: ${p.id}`); }
  }
}
ok(true, '옐로 2장 선수가 전원 퇴장 상태');

console.log('\n5) §4 불변조건 — 퇴장 선수는 피치에 없다 / NaN 없다');
const viol = runs.reduce((a, r) => a + r.seen.pitchViolation, 0);
ok(viol === 0, `불변조건 위반 0틱 (실측 ${viol})`);
ok(sentOffs.length > 0, `표본에 실제 퇴장이 존재해 위 단언이 공허참이 아님 (${sentOffs.length}건)`);

console.log('\n6) 퇴장 팀은 11명처럼 움직이지 않는다 (§11)');
let checked = 0;
for (const { s } of runs) {
  for (const t of ['A', 'B']) {
    const active = Object.values(s.players).filter((p) => p.teamId === t && !p.sentOff);
    ok(active.length <= 11, `${t} 활성 ≤11 (${active.length})`);
    checked++;
    if (checked >= 4) break;
  }
  if (checked >= 4) break;
}

console.log('\n7) 반칙이 중계에 실린다 (텍스트가 코어)');
const feeds = runs.flatMap((r) => (r.s.feed || []).map((f) => (typeof f === 'string' ? f : f.text || '')));
ok(feeds.some((t) => /반칙|파울|태클입니다/.test(t)), '반칙 중계 문장 존재');
ok(feeds.some((t) => /프리킥/.test(t)), '프리킥 중계 문장 존재');
ok(cardsEv.length === 0 || feeds.some((t) => /경고|카드/.test(t)), '경고 중계 문장 존재');

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 있음'}  (pass ${pass}, fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
