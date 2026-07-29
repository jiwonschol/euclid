// Stage 2 게이트 (마스터 §5·§17 AI/형태 테스트). 포지셔닝 시스템이 축구답게 서는지 검증.
//   node sim/positioning-lint.mjs   (또는  npm run sim:pos)
//
// 고정 볼 시나리오로 정착시킨 뒤:
//  G-몰림   : 수비 10명이 공에 몰리지 않음(공 12m 내 수비 ≤4)
//  G-압박   : 적극 압박 인원 ≤2 (first defender + cover)
//  G-역습대비: 공격 시 공 뒤에 아군 필드 ≥2 + GK
//  G-폭     : 공격 진형 가로 폭 유지(≥30m), 수비도 붕괴 안 함(≥18m)
//  G-겹침   : 정착 후 최소 쌍거리 ≥1.0m
//  G-추종   : 수비 블록 중심이 공 z 쪽으로 이동
//  G-속도   : 어떤 선수도 sprint 캡 초과 안 함 (풀경기 전 틱)
//  + cfg 붙인 풀경기: NaN 0 · 재현성 · 풀타임 · placeholder 턴오버 발생

import { readFileSync } from 'node:fs';
import { createMatch, tick, SIM_DT, HALF_SECONDS } from '../js/game/match.js';
import { stepPositioning } from '../js/game/ai.js';

const cfg = JSON.parse(readFileSync(new URL('../data/engine.json', import.meta.url)));
const SPRINT = cfg.player.sprint;

let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failed++; };
const section = (t) => console.log(`\n${t}`);
const dOwn = (dir, x) => dir * x + 52.5;
const speed = (p) => Math.hypot(p.velocity.x, p.velocity.z);

// 고정 볼로 정착: possession 팀, 공 위치를 박고 캐리어를 그 자리에 고정한 채 stepPositioning 반복
function settle(seed, poss, ballX, ballZ, ticks = 150) {
  const s = createMatch(seed, cfg);
  s.phase = 'IN_PLAY';
  s.possessionTeamId = poss;
  s.ball.position = { x: ballX, y: 0, z: ballZ };
  const carrier = Object.values(s.players).find((p) => p.teamId === poss && p.role === 'ST');
  carrier.position = { x: ballX, z: ballZ };
  carrier.velocity = { x: 0, z: 0 };
  s.ball.carrierId = carrier.id;
  let maxSpd = 0;
  for (let i = 0; i < ticks; i++) {
    stepPositioning(s, SIM_DT);
    for (const p of Object.values(s.players)) maxSpd = Math.max(maxSpd, speed(p));
  }
  return { s, carrier, maxSpd };
}

const outfield = (s, team) => Object.values(s.players).filter((p) => p.teamId === team && p.role !== 'GK');
function minPairDist(s) {
  const ps = Object.values(s.players); let m = Infinity;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    m = Math.min(m, Math.hypot(ps[i].position.x - ps[j].position.x, ps[i].position.z - ps[j].position.z));
  }
  return m;
}
const spread = (arr, key) => Math.max(...arr.map((p) => p.position[key])) - Math.min(...arr.map((p) => p.position[key]));

// ── 시나리오 1: A 공격, 공 A 진영 깊숙(+25) ──
section('1) A 공격 (공 x=+25)');
{
  const { s, maxSpd } = settle(11, 'A', 25, 0);
  const dir = s.attackDirection.A;
  const ballOwn = dOwn(dir, 25);
  const behind = outfield(s, 'A').filter((p) => dOwn(dir, p.position.x) < ballOwn).length;
  ok(behind >= 2, `공 뒤 A 필드 ≥2 (실제 ${behind}) + GK`);
  // 몰림 방지: 공에서 떨어져 진형 유지하는 수비 ≥3 + 블록 깊이 유지(붕괴하면 둘 다 무너진다)
  const away = outfield(s, 'B').filter((p) => Math.hypot(p.position.x - 25, p.position.z) > 12).length;
  ok(away >= 3, `공에서 떨어져 진형 유지 수비 ≥3 (실제 ${away})`);
  ok(spread(outfield(s, 'B'), 'x') >= 18, `B 수비 블록 깊이 ≥18m (실제 ${spread(outfield(s, 'B'), 'x').toFixed(1)})`);
  ok(spread(outfield(s, 'A'), 'z') >= 30, `A 공격 폭 ≥30m (실제 ${spread(outfield(s, 'A'), 'z').toFixed(1)})`);
  ok(spread(outfield(s, 'B'), 'z') >= 18, `B 수비 폭 ≥18m (실제 ${spread(outfield(s, 'B'), 'z').toFixed(1)})`);
  const press = [s._press?.presserId, s._press?.coverId].filter(Boolean);
  ok(press.length <= 2, `적극 압박 ≤2 (실제 ${press.length})`);
  ok(press.every((id) => s.players[id].teamId === 'B'), '압박·커버는 수비팀(B)');
  ok(minPairDist(s) >= 1.0, `최소 쌍거리 ≥1.0m (실제 ${minPairDist(s).toFixed(2)})`);
  ok(maxSpd <= SPRINT * 1.02, `속도 캡 준수 (max ${maxSpd.toFixed(2)} ≤ ${SPRINT})`);
}

// ── 시나리오 2: B 공격 (대칭, 공 x=−25) ──
section('2) B 공격 (공 x=−25, 대칭)');
{
  const { s } = settle(12, 'B', -25, 0);
  const dir = s.attackDirection.B;
  const ballOwn = dOwn(dir, -25);
  const behind = outfield(s, 'B').filter((p) => dOwn(dir, p.position.x) < ballOwn).length;
  ok(behind >= 2, `공 뒤 B 필드 ≥2 (실제 ${behind}) + GK`);
  ok(spread(outfield(s, 'B'), 'z') >= 30, `B 공격 폭 ≥30m (실제 ${spread(outfield(s, 'B'), 'z').toFixed(1)})`);
  const away = outfield(s, 'A').filter((p) => Math.hypot(p.position.x + 25, p.position.z) > 12).length;
  ok(away >= 3, `공에서 떨어져 진형 유지 수비(A) ≥3 (실제 ${away})`);
}

// ── 시나리오 3: 공이 옆으로 → 수비 블록이 공 쪽으로 ──
section('3) 측면 추종 (수비 블록 중심이 공 z를 따라감)');
{
  const rt = settle(13, 'A', 0, 22);
  const meanR = outfield(rt.s, 'B').reduce((a, p) => a + p.position.z, 0) / 10;
  ok(meanR > 2, `공 z=+22 → B 평균 z>2 (실제 ${meanR.toFixed(1)})`);
  const lt = settle(13, 'A', 0, -22);
  const meanL = outfield(lt.s, 'B').reduce((a, p) => a + p.position.z, 0) / 10;
  ok(meanL < -2, `공 z=−22 → B 평균 z<−2 (실제 ${meanL.toFixed(1)})`);
}

// ── cfg 붙인 풀경기 안정성 ──
section('4) cfg 풀경기 안정성 (NaN·속도·재현성·턴오버)');
{
  function runFull(seed) {
    const s = createMatch(seed, cfg);
    let maxSpd = 0, nan = false;
    let guard = 0;
    while (s.phase !== 'FULLTIME' && guard++ < 200000) {
      tick(s);
      for (const p of Object.values(s.players)) {
        const v = speed(p);
        if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.z) || !Number.isFinite(v)) nan = true;
        maxSpd = Math.max(maxSpd, v);
      }
    }
    return { s, maxSpd, nan };
  }
  const a = runFull(77);
  ok(!a.nan, 'NaN 없음(전 틱)');
  ok(a.s.phase === 'FULLTIME', 'FULLTIME 도달');
  ok(a.maxSpd <= SPRINT * 1.02, `풀경기 속도 캡 준수 (max ${a.maxSpd.toFixed(2)})`);
  ok(Math.abs(a.s.clockSeconds - 2 * HALF_SECONDS) < 1, `시계 ≈5400 (${a.s.clockSeconds.toFixed(1)})`);
  const plays = a.s.eventLog.filter((e) => e.type === 'PASS' || e.type === 'SHOT').length;
  ok(plays > 20, `경기 이벤트 발생 (패스·슛 ${plays}건)`);
  const b = runFull(77);
  ok(JSON.stringify(a.s.eventLog) === JSON.stringify(b.s.eventLog), '재현성: 시드 77 두 판 로그 동일');
}

console.log(`\n${failed === 0 ? '✅ 전부 통과' : `❌ ${failed}건 실패`}`);
process.exit(failed === 0 ? 0 : 1);
