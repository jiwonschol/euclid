// Stage 3 게이트 (마스터 §7·§17). 창발 경기 루프(패스·슛·컨트롤·득점)가 건강한지 검증.
//   node sim/play-lint.mjs   (또는  npm run sim:play)

import { readFileSync } from 'node:fs';
import { createMatch, tick, HALF_SECONDS } from '../js/game/match.js';
import { FIELD } from '../js/game/field.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));
const SPRINT = cfg.player.sprint, SHOTMAX = cfg.ball.shotMax;

let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failed++; };
const section = (t) => console.log(`\n${t}`);
const bspeed = (b) => Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);

function runFull(seed) {
  const s = createMatch(seed, cfg);
  const stat = { nan: false, maxP: 0, maxB: 0, oob: false, poss: new Set(), types: {} };
  let guard = 0;
  while (s.phase !== 'FULLTIME' && guard++ < 200000) {
    const before = s.eventLog.length;
    tick(s);
    for (let i = before; i < s.eventLog.length; i++) { const e = s.eventLog[i].type; stat.types[e] = (stat.types[e] || 0) + 1; }
    if (s.possessionTeamId) stat.poss.add(s.possessionTeamId);
    for (const p of Object.values(s.players)) {
      const v = Math.hypot(p.velocity.x, p.velocity.z);
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.z) || !Number.isFinite(v)) stat.nan = true;
      stat.maxP = Math.max(stat.maxP, v);
    }
    const b = s.ball;
    if (!Number.isFinite(b.position.x) || !Number.isFinite(b.position.z)) stat.nan = true;
    stat.maxB = Math.max(stat.maxB, bspeed(b));
    if (Math.abs(b.position.x) > FIELD.halfLength + 0.6 || Math.abs(b.position.z) > FIELD.halfWidth + 0.6) stat.oob = true;
  }
  return { s, stat };
}

section('1) 창발 경기 루프 (시드 5)');
const { s, stat } = runFull(5);
ok(!stat.nan, 'NaN 없음(전 틱, 공 포함)');
ok(s.phase === 'FULLTIME', 'FULLTIME 도달');
ok(Math.abs(s.clockSeconds - 2 * HALF_SECONDS) < 1, `시계 ≈5400 (${s.clockSeconds.toFixed(1)})`);
ok(stat.maxP <= SPRINT * 1.02, `선수 속도 캡 (max ${stat.maxP.toFixed(2)} ≤ ${SPRINT})`);
ok(stat.maxB <= SHOTMAX * 1.25, `공 속도 물리적(순간이동 없음, max ${stat.maxB.toFixed(1)} ≤ ${(SHOTMAX * 1.25).toFixed(0)})`);
ok(!stat.oob, '공이 경계 밖에 머물지 않음(아웃 즉시 재개)');
ok(stat.poss.has('A') && stat.poss.has('B'), '양 팀 모두 점유함');
ok((stat.types.PASS || 0) + (stat.types.THROUGH || 0) > 50, `패스 발생 (${(stat.types.PASS || 0) + (stat.types.THROUGH || 0)}회)`);
ok((stat.types.SHOT || 0) > 0, `슛 발생 (${stat.types.SHOT || 0}회)`);
ok((stat.types.INTERCEPT || 0) + (stat.types.TACKLE || 0) + (stat.types.COLLECT || 0) > 0, `탈취/가로채기/수집 발생`);
console.log('    이벤트:', JSON.stringify(stat.types), '  스코어:', JSON.stringify(s.score));

section('2) 재현성 (같은 시드 → 로그 동일)');
const a2 = runFull(5), b2 = runFull(5);
ok(JSON.stringify(a2.s.eventLog) === JSON.stringify(b2.s.eventLog), '시드 5 두 판 이벤트 로그 완전 동일');
ok(a2.s.score.A === b2.s.score.A && a2.s.score.B === b2.s.score.B, '최종 스코어 동일');

section('3) 밸런스·득점 분포 (여러 시드, 데드락/방향편향 없음)');
// 주의: 오프사이드(Stage 4) 전이라 골이 실제(≈2.6)보다 높다. 여기선 "폭주 아님 + 방향 편향 없음"만 본다.
let totalGoals = 0, aWins = 0, bWins = 0;
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const r = runFull(seed);
  totalGoals += r.s.score.A + r.s.score.B;
  if (r.s.score.A > r.s.score.B) aWins++; else if (r.s.score.B > r.s.score.A) bWins++;
  ok(r.s.phase === 'FULLTIME' && !r.stat.nan, `시드 ${seed}: 완주·NaN없음 (${r.s.score.A}-${r.s.score.B})`);
}
ok(totalGoals > 20 && totalGoals < 300, `득점 정상 범위 (8경기 합 ${totalGoals}, 오프사이드 전)`);
ok(aWins >= 1 && bWins >= 1, `양 팀 모두 승리 가능 = 방향 편향 없음 (A${aWins} / B${bWins})`);

console.log(`\n${failed === 0 ? '✅ 전부 통과' : `❌ ${failed}건 실패`}`);
process.exit(failed === 0 ? 0 : 1);
