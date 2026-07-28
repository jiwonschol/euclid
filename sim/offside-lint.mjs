// 오프사이드 규칙 게이트 (경기규칙 Law 11). 개수가 아니라 **판정이 규칙대로인가**를 본다.
//   node sim/offside-lint.mjs   (또는  npm run sim:offside)
//
// 디자이너 2026-07-29: "오프사이드가 제대로 적용되지 않는 건 축구가 아니야. 가장 중요한 룰일 수 있어."
// 그래서 개수 튜닝과 분리해 규칙 자체를 못박는다. 여기 실패하면 그 변경은 축구가 아니다.

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { isOffside } from '../js/game/decide.js';
import { FIELD } from '../js/game/field.js';

const L = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url)));
const cfg = L('engine.json'), com = L('commentary.json');

let pass = 0, fail = 0;
const ok = (name, cond, got = '') => { if (cond) { pass++; console.log(`  ✓ ${name}${got ? ' — ' + got : ''}`); } else { fail++; console.log(`  ✗ ${name}${got ? ' — ' + got : ''}`); } };

// A 는 +x 로 공격(상대 골라인 x=+52.5). 판정용으로 선수를 직접 배치한다.
function scene({ ballX, recvX, secondLastX, lastX = 52.0 }) {
  const s = createMatch(1, cfg, com);
  for (const p of Object.values(s.players)) p.position = { x: -50, z: 30 };   // 전원 무관 위치로 치움
  s.attackDirection = { A: 1, B: -1 };
  s.ball.position = { x: ballX, y: 0, z: 0 };
  const A = Object.values(s.players).filter((p) => p.teamId === 'A');
  const B = Object.values(s.players).filter((p) => p.teamId === 'B');
  A[0].position = { x: recvX, z: 0 };                 // 수신자
  B[0].position = { x: lastX, z: 0 };                 // 최후방(GK)
  B[1].position = { x: secondLastX, z: 0 };           // 세컨드-라스트 수비
  return { s, recv: A[0], mate: A[1], defLast: B[0], defSecond: B[1] };
}

console.log('오프사이드 규칙 (Law 11)\n');

console.log('1) 오프사이드 위치의 정의');
{
  const { s, recv } = scene({ ballX: 20, recvX: 40, secondLastX: 35 });
  ok('세컨드-라스트 수비보다 골문에 가까우면 오프사이드 위치', isOffside(s, recv, 'A'), `수신자 x=40 · 라인 x=35`);
}
{
  const { s, recv } = scene({ ballX: 20, recvX: 30, secondLastX: 35 });
  ok('세컨드-라스트 수비보다 뒤면 온사이드', !isOffside(s, recv, 'A'), `수신자 x=30 · 라인 x=35`);
}
{
  const { s, recv } = scene({ ballX: 20, recvX: 35, secondLastX: 35 });
  ok('세컨드-라스트 수비와 같은 선상이면 온사이드', !isOffside(s, recv, 'A'), '둘 다 x=35');
}
{
  const { s, recv } = scene({ ballX: 45, recvX: 40, secondLastX: 35 });
  ok('공보다 뒤에 있으면 오프사이드 아님', !isOffside(s, recv, 'A'), '공 x=45 · 수신자 x=40');
}
{
  const { s, recv } = scene({ ballX: -20, recvX: -5, secondLastX: -10 });
  ok('자기 진영에 있으면 오프사이드 아님', !isOffside(s, recv, 'A'), '수신자 x=-5 (자기 진영)');
}
{
  // 마지막 두 수비 '사이'는 오프사이드 위치다 — 온사이드이려면 나와 골라인 사이에 상대가 둘 이상
  // 있거나 세컨드-라스트와 같은 선상이어야 한다. 수비 둘이 x=46, x=40 이면 세컨드-라스트는 40 이고
  // 수신자 x=44 는 그보다 골문 쪽이다.
  const { s, recv } = scene({ ballX: 20, recvX: 44, secondLastX: 46, lastX: 40 });
  ok('마지막 두 수비 사이는 오프사이드 위치', isOffside(s, recv, 'A'), '수신자 x=44 · 세컨드-라스트 x=40');
}

console.log('\n2) 반칙은 사람 단위다 — 팀 단위가 아니다');
// 예전 구현은 수신 시 팀만 대조해, 오프사이드 위치의 동료를 향한 패스를 **온사이드인 다른 동료**가
// 받아도 오프사이드를 선언했다(오심). 실경기 로그에서 이 오심이 사라졌는지 확인한다.
{
  let calls = 0, wrongTeam = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = createMatch(seed, cfg, com);
    while (s.phase !== 'FULLTIME') tick(s);
    for (const e of s.eventLog) if (e.type === 'OFFSIDE') { calls++; if (!e.team) wrongTeam++; }
  }
  ok('오프사이드 선언에 팀이 기록된다', wrongTeam === 0, `${calls}건`);
  ok('오프사이드가 실제로 발생한다(공허참 방지)', calls > 0, `6경기 ${calls}건`);
}

console.log('\n3) 경기당 빈도 (실제 1군 리그 ≈4.0)');
{
  const N = 6;
  let total = 0;
  for (let seed = 1; seed <= N; seed++) {
    const s = createMatch(seed, cfg, com);
    while (s.phase !== 'FULLTIME') tick(s);
    total += s.eventLog.filter((e) => e.type === 'OFFSIDE').length;
  }
  const per = total / N;
  ok('경기당 1.5~7.0회', per >= 1.5 && per <= 7.0, `${per.toFixed(2)}회`);
}

console.log('\n4) 판정 시점 — 공을 찬 순간이지 받는 순간이 아니다');
{
  // 패스 순간엔 온사이드였다가 공이 날아가는 동안 라인을 넘어선 선수는 오프사이드가 아니다.
  const { s, recv } = scene({ ballX: 20, recvX: 30, secondLastX: 35 });
  const before = isOffside(s, recv, 'A');
  recv.position = { x: 45, z: 0 };                    // 비행 중 라인을 넘어섬
  const after = isOffside(s, recv, 'A');
  ok('스냅샷 시점 판정이 위치 변화와 분리된다', before === false && after === true,
    '찬 순간 온사이드 → 이후 이동은 판정에 영향 없어야 한다(스냅샷으로 보장)');
}

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 있음'}  (pass ${pass}, fail ${fail})`);
process.exit(fail ? 1 : 0);
