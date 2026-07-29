// Stage 1 스모크 테스트 (마스터 계획서 §17 규칙/안정성 테스트의 골격분).
// 연속 경기 엔진이 결정적으로·안전하게 도는지 보증한다.
//   node sim/match-smoke.mjs   (또는  npm run sim:match)
//
// 검사:
//  1) 팀당 11명 · 정확히 1명 GK · 총 22명
//  2) 초기 좌표 유한 & 경계 안
//  3) 같은 시드 → 이벤트 로그 완전 동일(재현성, §17)
//  4) 다른 시드 → 킥오프 코인토스가 갈릴 수 있음(RNG 실제 소비 증명)
//  5) 후반 시작 시 attackDirection 부호 반전(§3/§11)
//  6) FULLTIME 도달 & 시계 ≈ 5400초 & NaN 없음(assertFinite 통과)

import { createMatch, tick, runToFulltime, tickUntil, HALF_SECONDS } from '../js/game/match.js';
import { FIELD } from '../js/game/field.js';

let failed = 0;
function ok(cond, msg) {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) failed++;
}
function section(t) { console.log(`\n${t}`); }

// 1) 스쿼드 구성
section('1) 스쿼드 구성');
{
  const s = createMatch(1);
  const ids = Object.keys(s.players);
  ok(ids.length === 22, `총 22명 (실제 ${ids.length})`);
  for (const team of ['A', 'B']) {
    const roster = Object.values(s.players).filter((p) => p.teamId === team);
    const gks = roster.filter((p) => p.role === 'GK');
    ok(roster.length === 11, `${team}팀 11명 (실제 ${roster.length})`);
    ok(gks.length === 1, `${team}팀 GK 정확히 1명 (실제 ${gks.length})`);
  }
}

// 2) 초기 좌표 유한 & 경계 안
section('2) 초기 좌표 유한 & 경계 안');
{
  const s = createMatch(7);
  let allFinite = true, allIn = true;
  for (const p of Object.values(s.players)) {
    if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.z)) allFinite = false;
    if (Math.abs(p.position.x) > FIELD.halfLength + 0.5 || Math.abs(p.position.z) > FIELD.halfWidth + 0.5) allIn = false;
  }
  ok(allFinite, '모든 선수 좌표 유한');
  ok(allIn, '모든 선수 경계 안');
  // GK 는 자기 골문 근처
  const gkA = Object.values(s.players).find((p) => p.teamId === 'A' && p.role === 'GK');
  ok(gkA.position.x < -40, `A GK 자기 골문(-x)쪽 (x=${gkA.position.x.toFixed(1)})`);
}

// 3) 재현성: 같은 시드 → 로그 동일
section('3) 재현성 (같은 시드 → 이벤트 로그 동일)');
{
  const a = runToFulltime(createMatch(42));
  const b = runToFulltime(createMatch(42));
  ok(JSON.stringify(a.eventLog) === JSON.stringify(b.eventLog), '시드 42 두 판 로그 완전 동일');
  ok(a.eventLog.length > 0, `로그 비어있지 않음 (${a.eventLog.length}건)`);
}

// 4) RNG 실제 소비 (시드에 따라 코인토스 갈림)
section('4) 시드 기반 코인토스');
{
  const seen = new Set();
  for (let seed = 1; seed <= 20; seed++) seen.add(createMatch(seed).kickoffFirstHalf);
  ok(seen.size === 2, `20개 시드에서 A·B 킥오프 모두 등장 (실제 ${[...seen].join(',')})`);
}

// 5) 후반 방향 반전
section('5) 후반 attackDirection 반전 (§3/§11)');
{
  const s = createMatch(3);
  const dirA1 = s.attackDirection.A, dirB1 = s.attackDirection.B;
  const reached = tickUntil(s, (st) => st.half === 2 && st.phase === 'IN_PLAY');
  ok(reached, '후반 IN_PLAY 도달');
  ok(s.attackDirection.A === -dirA1, `A 방향 반전 (${dirA1} → ${s.attackDirection.A})`);
  ok(s.attackDirection.B === -dirB1, `B 방향 반전 (${dirB1} → ${s.attackDirection.B})`);
}

// 6) 풀타임 도달 & 시계
section('6) 풀타임 도달 & 시계 무결성');
{
  const s = runToFulltime(createMatch(99));
  ok(s.phase === 'FULLTIME', `FULLTIME 도달 (phase=${s.phase})`);
  ok(Math.abs(s.clockSeconds - 2 * HALF_SECONDS) < 1, `시계 ≈ 5400초 (실제 ${s.clockSeconds.toFixed(2)})`);
  const events = s.eventLog.map((e) => e.type);
  ok(events.includes('HALFTIME') && events.includes('SECOND_HALF') && events.includes('FULLTIME'),
     '전·후반·종료 이벤트 모두 기록');
}

console.log(`\n${failed === 0 ? '✅ 전부 통과' : `❌ ${failed}건 실패`}`);
process.exit(failed === 0 ? 0 : 1);
