// 소유 단위 해부 — "왜 이런 숫자가 나오는가"를 묻는 상설 도구
//
//   node sim/diagnose.mjs [경기수] [--no-policy] [--policy 파일]
//
// 눈금(sim/realism-lint.mjs)은 **무엇이** 어긋났는지 말해주고, 이건 **왜** 그런지를 말해준다.
// 이 저장소에서 진짜 원인을 찾아낸 건 언제나 총량 통계가 아니라 소유 단위 해부였다:
//
//   2026-08-12  태클 471회에 소유 전환은 227회 → 태클이 공을 캐리어 발밑에 떨구고 있었다
//   2026-08-12  슛의 91%가 0-6m → GK 가 좌표 상수로 서 있었다
//   2026-08-26  슈터가 공 잡고 11.7초·49.9m 단독 드리블, 그 동안 최근접 수비 1.9m·태클 0회
//               → press.standoff 2.2m 가 control.controlRadius 1.5m 밖이었다
//
// 그래서 매번 scratchpad 에 다시 짓지 말고 여기 둔다. 여기 없는 각도가 필요하면 **추가한다**.
// rng 미소비(읽기만 한다). 정책을 넘기지 않으면 레거시(손으로 쓴 효용) 경로를 잰다.

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { FIELD } from '../js/game/field.js';

const ROOT = new URL('..', import.meta.url).pathname;
const L = (p) => JSON.parse(readFileSync(ROOT + 'data/' + p, 'utf8'));
const cfg = L('engine.json'), com = L('commentary.json');

const argv = process.argv.slice(2);
const N = Number(argv.find((a) => /^\d+$/.test(a)) || 3);
const pi = argv.indexOf('--policy');
const POL = argv.includes('--no-policy') ? null
  : JSON.parse(readFileSync(pi >= 0 ? argv[pi + 1] : ROOT + 'data/policy.json', 'utf8'));

const BOX_X = 16.5, BOX_Z = 20.16;
const BANDS = [[0, 6], [6, 11], [11, 16], [16, 22], [22, 30], [30, 60]];
const inBox = (x, z, goalX) => Math.abs(x - goalX) < BOX_X && Math.abs(z) < BOX_Z;
const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

const ev = {};
const band = BANDS.map(() => ({ shots: 0, goals: 0, save: 0, block: 0 }));
const carryDist = [], carrySec = [], nearDef = [], nearDefBox = [], boxDefN = [], gkOut = [], shotGap = [];
// ⚠️ 페널티는 따로 센다. goalRestart→resetFormation 이 22명을 홈 앵커로 되돌린 **뒤에** 이벤트를
// 훑기 때문에, PK 슛을 오픈플레이로 세면 '키커 홈 앵커'(골문 30~60m)에서 쏜 것으로 기록돼
// "30-60m 전환율 100%" 같은 유령이 생긴다(2026-08-26 실제로 낚였다).
let pkShots = 0, pkGoals = 0;
const defLine = [];   // 상대가 우리 박스에 있을 때 우리 아웃필더 10명의 자기 골문까지 거리(가까운 순)

for (let m = 0; m < N; m++) {
  const pol = POL ? { A: POL, B: POL } : null;
  const s = createMatch(7000 + m, cfg, com, null, pol);
  const gain = new Map();
  let seen = 0, lastShotT = null, pending = null;

  while (s.phase !== 'FULLTIME') {
    const prev = s.ball.carrierId;
    tick(s);
    const c = s.ball.carrierId;
    if (c && c !== prev) gain.set(c, { t: s.clockSeconds, x: s.players[c].position.x, z: s.players[c].position.z });

    for (; seen < s.eventLog.length; seen++) {
      const e = s.eventLog[seen];
      ev[e.type] = (ev[e.type] || 0) + 1;
      if (e.type === 'SHOT' && e.pk) { pkShots++; pending = 'pk'; continue; }   // 페널티는 오픈플레이가 아니다
      if (e.type === 'SHOT') {
        const p = s.players[e.by]; if (!p) continue;
        const gx = s.attackDirection[e.team] * FIELD.halfLength;
        const d = Math.hypot(gx - p.position.x, p.position.z);
        const bi = BANDS.findIndex(([a, b]) => d >= a && d < b);
        pending = bi >= 0 ? bi : null;
        if (pending !== null) band[pending].shots++;
        if (lastShotT !== null) shotGap.push(s.clockSeconds - lastShotT);
        lastShotT = s.clockSeconds;
        const g = gain.get(e.by);
        if (g) { carryDist.push(Math.hypot(p.position.x - g.x, p.position.z - g.z)); carrySec.push(s.clockSeconds - g.t); }
      } else if (pending === 'pk') {
        if (e.type === 'GOAL') { pkGoals++; pending = null; }
        else if (e.type === 'SAVE' || e.type === 'PK_MISS') pending = null;
      } else if (pending !== null && (e.type === 'GOAL' || e.type === 'SAVE' || e.type === 'BLOCK')) {
        band[pending][e.type === 'GOAL' ? 'goals' : e.type === 'SAVE' ? 'save' : 'block']++;
        pending = null;
      }
    }

    if (s.tickCount % 15) continue;                      // 1초마다만 표집

    const car = s.ball.carrierId ? s.players[s.ball.carrierId] : null;
    if (car && car.role !== 'GK') {
      let bd = Infinity;
      for (const o of Object.values(s.players)) {
        if (o.teamId === car.teamId || o.sentOff) continue;
        bd = Math.min(bd, Math.hypot(o.position.x - car.position.x, o.position.z - car.position.z));
      }
      if (Number.isFinite(bd)) {
        nearDef.push(bd);
        const gx = s.attackDirection[car.teamId] * FIELD.halfLength;
        if (inBox(car.position.x, car.position.z, gx)) nearDefBox.push(bd);
      }
    }

    for (const p of Object.values(s.players)) {
      if (p.role !== 'GK') continue;
      gkOut.push(Math.abs(p.position.x - (-s.attackDirection[p.teamId] * FIELD.halfLength)));
    }

    const b = s.ball.position;
    for (const t of ['A', 'B']) {
      const og = -s.attackDirection[t] * FIELD.halfLength;
      if (!inBox(b.x, b.z, og) || s.possessionTeamId === t) continue;   // 우리가 공을 가진 순간은 제외
      const ds = [];
      let n = 0;
      for (const p of Object.values(s.players)) {
        if (p.teamId !== t || p.role === 'GK' || p.sentOff) continue;
        ds.push(Math.hypot(p.position.x - og, p.position.z));
        if (inBox(p.position.x, p.position.z, og)) n++;
      }
      boxDefN.push(n);
      if (ds.length === 10) defLine.push(ds.sort((x, y) => x - y));
    }
  }
}

const per = (v) => (v / N).toFixed(1);
const g = (k) => per(ev[k] || 0);
console.log(`소유 해부 — ${N}경기 · 정책 ${POL ? `세대 ${POL.generation}` : '없음(레거시 효용)'}\n`);

console.log('이벤트/경기');
for (const [k, v] of Object.entries(ev).sort((a, b) => b[1] - a[1])) {
  if (v / N < 0.2) continue;
  console.log(`  ${k.padEnd(14)}${per(v).padStart(7)}`);
}

console.log('\n슛은 어디서 나오는가');
console.log('  거리대      슛/경기    선방    블록     골   골/슛');
BANDS.forEach(([a, b], i) => {
  const x = band[i]; if (!x.shots) return;
  console.log(`  ${String(a).padStart(2)}-${String(b).padEnd(3)}m  ${per(x.shots).padStart(7)} ${per(x.save).padStart(7)} ${per(x.block).padStart(7)} ${per(x.goals).padStart(6)}   ${(100 * x.goals / x.shots).toFixed(0)}%`);
});
console.log(`  슛 간격 중앙값 ${q(shotGap, 0.5).toFixed(1)}초`);
console.log(`  페널티(오픈플레이 아님): ${per(pkShots)}회/경기 · 전환율 ${(100 * pkGoals / Math.max(1, pkShots)).toFixed(0)}%   실축 0.25회 · 76%`);

console.log('\n캐리어는 어떻게 거기까지 가는가  (실축: 한 소유의 단독 운반은 몇 m 수준)');
console.log(`  공 잡고 → 슛까지: 중앙값 ${q(carrySec, 0.5).toFixed(1)}초 · 이동 ${q(carryDist, 0.5).toFixed(1)}m`);
console.log(`  캐리어→최근접 수비: 중앙값 ${q(nearDef, 0.5).toFixed(1)}m · p25 ${q(nearDef, 0.25).toFixed(1)}m`
  + `  (상대 박스 안에서 ${q(nearDefBox, 0.5).toFixed(1)}m)`);
console.log(`  참고 — 태클이 닿는 거리 ${cfg.duel?.reach ?? cfg.control.controlRadius}m · 압박 standoff ${cfg.press.standoff}m`);
console.log('  ⚠️ standoff 가 reach 보다 크면 첫 수비수는 영원히 태클을 못 한다(2026-08-26 실제 버그).');

console.log('\n상대가 공을 가지고 우리 박스에 있을 때  (실축 박스 안 수비 4~8명)');
console.log(`  박스 안 수비 인원 평균 ${mean(boxDefN).toFixed(2)}명`);
if (defLine.length) {
  const nth = (n) => mean(defLine.map((d) => d[n])).toFixed(0);
  console.log(`  아웃필더 10명의 자기 골문까지 거리(가까운 순): ${[0,1,2,3,4,5,6,7,8,9].map(nth).join(' · ')} m`);
}
console.log(`  GK 골라인 이탈: 중앙값 ${q(gkOut, 0.5).toFixed(1)}m · p95 ${q(gkOut, 0.95).toFixed(1)}m`);
