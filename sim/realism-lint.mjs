// 축구다움 눈금 (goal-harness 루프 전용). 기존 게이트 8종이 "안 나빠졌다"를 재는 반면
// 이 스크립트는 "축구로 읽히는가"를 잰다 — 디자이너가 지목한 다섯 항목을 수치로 옮긴 것.
//   node sim/realism-lint.mjs [--json] [--matches N] [--delta-matches M]
//
// 표적: docs/reference/match_stats.md (실제 1군 리그 90분 기준) + docs/reference/target-pitch.png
// 이 파일은 루프가 수정할 수 없다(.claude/loop/guard.mjs 가 해시로 고정). 임계값을 낮추는 것은 봉쇄 위반.
//
// 눈금 4개(각각 0~1 점수, 1이 목표 도달):
//   M1 공간   — GK 골문 지킴 · 공 주변 몰림 · 진형이 공을 따라감 · 팀 폭/라인 간격
//   M2 통계   — 골·슛·유효·xG/슛·파울·코너·오프사이드가 실제 축구 범위인가 (정규 90분)
//   M3 중계   — 템플릿 토큰 누출 · 근접 중복 · 분당 밀도
//   M4 게임형태 — 실플레이 시간 · 분기점 밀도 · 개입 델타(카드가 결과를 바꾸는가)

import { readFileSync } from 'node:fs';
import { createMatch, tick } from '../js/game/match.js';
import { selectStance, acceptAdvice, playSub } from '../js/game/stance.js';
import { FIELD, penaltyBoxOf } from '../js/game/field.js';

const L = (p) => JSON.parse(readFileSync(new URL('../data/' + p, import.meta.url)));
const cfg = L('engine.json'), com = L('commentary.json'), stc = L('stance.json');
const REF = L('../docs/reference/match_stats.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const N_MATCH = parseInt(arg('--matches', '12'), 10);      // 통계·공간 표본
const N_DELTA = parseInt(arg('--delta-matches', '40'), 10); // 개입 델타 표본(정책당)
const SAMPLE_EVERY = 15;                                    // 공간 지표 샘플링(1초마다)

// ── 통계 도우미 ──────────────────────────────────────────────
const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length); if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
/** 목표 도달을 0~1 로: value 가 good 쪽이면 1, bad 를 넘으면 0, 사이는 선형. */
const score = (v, good, bad) => Math.max(0, Math.min(1, (bad - v) / (bad - good)));

// ── 경기 실행 ────────────────────────────────────────────────
/** 정규 90분(stanceCfg 없음)으로 돌리며 공간·통계 표본을 모은다. */
function runRegulation(seed) {
  const s = createMatch(seed, cfg, com);
  const gkDist = [], crowd = [], widthZ = [], depthX = [], boxCount = [];
  const thirds = { own: 0, mid: 0, opp: 0 };
  const ballXs = [], defCxs = [];
  const speeds = [], passSpeeds = [];
  let ticks = 0, sprintTicks = 0, speedSamples = 0, walkSamples = 0;
  while (s.phase !== 'FULLTIME') {
    tick(s); ticks++;
    // 움직임은 매 틱 본다(샘플링하면 스프린트 같은 짧은 사건을 놓친다)
    if (s.phase === 'IN_PLAY') {
      for (const p of Object.values(s.players)) {
        if (p.sentOff || p.role === 'GK' || !p.velocity) continue;
        const v = Math.hypot(p.velocity.x, p.velocity.z);
        speedSamples++; if (v < 1.5) walkSamples++; if (v > 7.5) sprintTicks++;
        if (speeds.length < 400000) speeds.push(v);
      }
      const bv = Math.hypot(s.ball.velocity.x, s.ball.velocity.z);
      if (s.ball.mode !== 'CONTROLLED' && bv > 8 && passSpeeds.length < 200000) passSpeeds.push(bv);
    }
    if (ticks % SAMPLE_EVERY || s.phase !== 'IN_PLAY') continue;
    const b = s.ball.position;
    const alive = Object.values(s.players).filter((p) => !p.sentOff);
    // S1 GK 골문 지킴 — 자기 골문(±52.5)까지 거리
    for (const p of alive) {
      if (p.role !== 'GK') continue;
      const goalX = -s.attackDirection[p.teamId] * FIELD.halfLength;
      gkDist.push(Math.hypot(p.position.x - goalX, p.position.z));
    }
    // S2 몰림 — 공 반경 10m 안 필드 선수 수
    crowd.push(alive.filter((p) => p.role !== 'GK' && Math.hypot(p.position.x - b.x, p.position.z - b.z) <= 10).length);
    // S3 진형 추종 — 수비팀(비점유) 필드 무게중심 x vs 공 x
    const def = s.possessionTeamId === 'A' ? 'B' : 'A';
    const dfs = alive.filter((p) => p.teamId === def && p.role !== 'GK');
    if (dfs.length >= 8) { ballXs.push(b.x); defCxs.push(mean(dfs.map((p) => p.position.x))); }
    // S8/S9 공격 구조 — 상대 박스 안 인원과 3분할 분포.
    // S2(공 10m 안)만으로는 '박스 안 스크럼'을 못 잡는다. 25m 에 걸쳐 8명이 몰려 있어도
    // 10m 반경에는 5명뿐이라 통과했다(실측 스냅샷에서 확인). 눈이 보는 것을 따로 재야 한다.
    if (s.possessionTeamId) {
      const att = s.possessionTeamId, adir = s.attackDirection[att];
      const mates = alive.filter((p) => p.teamId === att && p.role !== 'GK');
      boxCount.push(mates.filter((p) => penaltyBoxOf(p.position.x, p.position.z, adir) === 'opp').length);
      for (const p of mates) {
        const dd = adir * p.position.x + FIELD.halfLength;
        if (dd < 35) thirds.own++; else if (dd < 70) thirds.mid++; else thirds.opp++;
      }
    }
    // S4 폭/깊이 — 팀별 z 스팬, x 스팬
    for (const t of ['A', 'B']) {
      const f = alive.filter((p) => p.teamId === t && p.role !== 'GK');
      if (f.length < 8) continue;
      const zs = f.map((p) => p.position.z), xs = f.map((p) => p.position.x);
      widthZ.push(Math.max(...zs) - Math.min(...zs));
      depthX.push(Math.max(...xs) - Math.min(...xs));
    }
  }
  const ev = {};
  for (const e of s.eventLog) ev[e.type] = (ev[e.type] || 0) + 1;
  return { state: s, gkDist, crowd, widthZ, depthX, boxCount, thirds, corr: pearson(ballXs, defCxs), ev,
    speeds, passSpeeds, sprintTicks, speedSamples, walkSamples, matchMinutes: s.clockSeconds / 60 };
}

/** 손패 있는 실제 플레이 조건(stanceCfg 포함)으로 돌린다. policy: 'none' | 'good' */
function runPlayable(seed, policy) {
  const s = createMatch(seed, cfg, com, stc);
  const PICK = [['press', 'high'], ['mentality', 'attack'], ['line', 'up'], ['attack_zone', 'wing']];
  let i = 0, subs = 0;
  while (s.phase !== 'FULLTIME') {
    tick(s);
    if (policy === 'good' && s.stance) {
      // 참모 조언은 항상 수락(설계상 '읽고 대응'의 정답 경로), 조언 없으면 공세 스탠스, 후반 교체 소진
      if (s.advice) acceptAdvice(s, stc);
      else if (s.tickCount % 900 === 0) { const [g, o] = PICK[i++ % PICK.length]; selectStance(s, 'A', g, o, stc); }
      if (subs < 3 && s.half === 2 && s.tickCount % 1200 === 0) { if (playSub(s, ['fw', 'mf', 'df'][subs], stc).ok) subs++; }
    }
  }
  const hl = s.eventLog.filter((e) => e.type === 'HIGHLIGHT_START').length;
  const pts = s.score.A > s.score.B ? 3 : s.score.A === s.score.B ? 1 : 0;
  return { state: s, hl, pts, gf: s.score.A, ga: s.score.B, xgA: s.stats?.xg.A ?? 0 };
}

// ── M1 공간 ──────────────────────────────────────────────────
function metricSpace(runs) {
  const gkP95 = pctl(runs.flatMap((r) => r.gkDist), 0.95);
  const gkMax = runs.flatMap((r) => r.gkDist).reduce((a, b) => (b > a ? b : a), 0);   // spread 는 표본이 크면 스택을 넘긴다
  const crowdP95 = pctl(runs.flatMap((r) => r.crowd), 0.95);
  const corr = mean(runs.map((r) => r.corr));
  const width = pctl(runs.flatMap((r) => r.widthZ), 0.5);
  const depth = pctl(runs.flatMap((r) => r.depthX), 0.5);
  const T = REF.space;
  const checks = [
    { id: 'S1 GK 골문 지킴', got: `p95 ${gkP95.toFixed(1)}m · max ${gkMax.toFixed(1)}m`, ok: gkP95 <= T.gkDistP95Max && gkMax <= T.gkDistMax, want: `p95 ≤${T.gkDistP95Max} · max ≤${T.gkDistMax}` },
    { id: 'S2 공 주변 몰림', got: `p95 ${crowdP95}명`, ok: crowdP95 <= T.crowdP95Max, want: `≤${T.crowdP95Max}명` },
    // 밴드인 이유: 하한만 두면 팀을 공에 강체처럼 붙여 지표를 올리고 축구다움을 잃는다(실측 r=0.98).
    { id: 'S3 진형이 공을 따라감', got: `r=${corr.toFixed(2)}`, ok: corr >= T.shapeFollowMin && corr <= T.shapeFollowMax, want: `${T.shapeFollowMin}~${T.shapeFollowMax}` },
    { id: 'S4 폭·라인 간격', got: `폭 ${width.toFixed(0)}m · 깊이 ${depth.toFixed(0)}m`, ok: width >= T.widthMin && depth >= T.depthMin && depth <= T.depthMax, want: `폭 ≥${T.widthMin} · 깊이 ${T.depthMin}~${T.depthMax}` },
  ];

  // ── 움직임 (M1 에 편입) ─────────────────────────────────
  // 전원이 같은 속도로 계속 종종걸음하면 진형이 통째로 미끄러진다 — 눈금에 속도가 없어 못 잡던 결함.
  const M = REF.motion;
  const allSpeeds = runs.flatMap((r) => r.speeds);
  const avg = mean(allSpeeds), p95s = pctl(allSpeeds, 0.95);
  const walkShare = runs.reduce((a, r) => a + r.walkSamples, 0) / Math.max(1, runs.reduce((a, r) => a + r.speedSamples, 0));
  const sprintPerMin = runs.reduce((a, r) => a + r.sprintTicks, 0) / 15 / Math.max(1, runs.reduce((a, r) => a + r.matchMinutes, 0));
  const passP50 = pctl(runs.flatMap((r) => r.passSpeeds), 0.5);
  const A = REF.attackStructure;
  const boxP95 = pctl(runs.flatMap((r) => r.boxCount), 0.95);
  const th = runs.reduce((a, r) => ({ own: a.own + r.thirds.own, mid: a.mid + r.thirds.mid, opp: a.opp + r.thirds.opp }), { own: 0, mid: 0, opp: 0 });
  const thTot = th.own + th.mid + th.opp || 1;
  const ownPct = th.own / thTot, oppPct = th.opp / thTot;
  checks.push(
    { id: 'S8 상대 박스 안 인원', got: `p95 ${boxP95}명`, ok: boxP95 <= A.boxP95Max, want: `≤${A.boxP95Max}명` },
    { id: 'S9 3분할 분포', got: `자기 ${(ownPct * 100).toFixed(0)}% · 중원 ${((1 - ownPct - oppPct) * 100).toFixed(0)}% · 상대 ${(oppPct * 100).toFixed(0)}%`, ok: ownPct >= A.ownThirdMin && oppPct <= A.oppThirdMax, want: `자기 ≥${A.ownThirdMin * 100}% · 상대 ≤${A.oppThirdMax * 100}%` },
    { id: 'S5 평균 이동속도', got: `${avg.toFixed(2)} m/s · p95 ${p95s.toFixed(2)}`, ok: avg >= M.meanSpeedMin && avg <= M.meanSpeedMax && p95s >= M.p95SpeedMin && p95s <= M.p95SpeedMax, want: `평균 ${M.meanSpeedMin}~${M.meanSpeedMax} · p95 ${M.p95SpeedMin}~${M.p95SpeedMax}` },
    { id: 'S6 속도 다양성', got: `걷기/정지 ${(walkShare * 100).toFixed(0)}% · 스프린트 ${sprintPerMin.toFixed(1)}회/분`, ok: walkShare >= M.walkShareMin && sprintPerMin >= M.sprintPerMinMin, want: `걷기 ≥${M.walkShareMin * 100}% · 스프린트 ≥${M.sprintPerMinMin}/분` },
    { id: 'S7 패스 속도', got: `중앙값 ${passP50.toFixed(1)} m/s`, ok: passP50 >= M.passSpeedMin && passP50 <= M.passSpeedMax, want: `${M.passSpeedMin}~${M.passSpeedMax} m/s` },
  );

  return { checks, score: checks.filter((c) => c.ok).length / checks.length,
    raw: { gkP95, gkMax, crowdP95, corr, width, depth, boxP95, ownPct, oppPct, avgSpeed: avg, p95Speed: p95s, walkShare, sprintPerMin, passP50 } };
}

// ── M2 통계 (정규 90분) ──────────────────────────────────────
function metricStats(runs) {
  const per = (k) => mean(runs.map((r) => r.ev[k] || 0));
  const goals = mean(runs.map((r) => r.state.score.A + r.state.score.B));
  const shots = per('SHOT'), fouls = per('FOUL'), offs = per('OFFSIDE'), passes = per('PASS');
  const onT = mean(runs.map((r) => (r.state.stats?.onTarget.A ?? 0) + (r.state.stats?.onTarget.B ?? 0)));
  const corners = mean(runs.map((r) => (r.state.stats?.corners.A ?? 0) + (r.state.stats?.corners.B ?? 0)));
  const xgPer = mean(runs.map((r) => { const x = (r.state.stats?.xg.A ?? 0) + (r.state.stats?.xg.B ?? 0); const sh = r.ev.SHOT || 1; return x / sh; }));
  const R = REF.match90;
  const rows = [
    ['골', goals, R.goals], ['슛', shots, R.shots], ['유효슈팅', onT, R.onTarget],
    ['xG/슛', xgPer, R.xgPerShot], ['파울', fouls, R.fouls], ['코너', corners, R.corners],
    ['오프사이드', offs, R.offsides], ['패스', passes, R.passes],
  ].map(([name, got, want]) => ({ name, got, want, dev: Math.abs(got - want) / want }));
  const devSum = rows.reduce((a, r) => a + r.dev, 0);
  return { rows, devSum, score: score(devSum, REF.thresholds.devSumGood, REF.thresholds.devSumBad) };
}

// ── M3 중계 텍스트 ───────────────────────────────────────────
function metricFeed(playRuns) {
  const realMin = (stc.pace?.matchRealSec || 210) / 60;
  let leak = 0, lines = 0, repeats = 0, distinct = 0, totalForDistinct = 0;
  const leakSamples = [], repeatSamples = [];
  for (const r of playRuns) {
    const feed = r.state.feed || [];
    lines += feed.length;
    for (const f of feed) {
      if (/[{}#]/.test(f.text)) { leak++; if (leakSamples.length < 5) leakSamples.push(f.text); }
    }
    // 근접 재등장: 직전 WINDOW 줄 안에 같은 문장이 이미 나왔는가 — 줄 단위로 센다.
    // 쌍 비율로 재면 창 크기가 분모를 부풀려 실제 반복이 희석된다(교정 관문에서 확인: 템플릿을
    // 전부 한 문장으로 붕괴시켜도 쌍 비율은 2.05%→2.54% 밖에 안 움직였다).
    const WINDOW = 5;
    for (let i = 0; i < feed.length; i++) {
      for (let j = Math.max(0, i - WINDOW); j < i; j++) {
        if (feed[j].text !== feed[i].text) continue;
        repeats++; if (repeatSamples.length < 3) repeatSamples.push(feed[i].text);
        break;
      }
    }
    distinct += new Set(feed.map((f) => f.text)).size;
    totalForDistinct += feed.length;
  }
  const repeatPct = lines ? 100 * repeats / lines : 0;
  const distinctRatio = totalForDistinct ? distinct / totalForDistinct : 0;
  const perMin = lines / playRuns.length / realMin;
  const T = REF.feed;
  const checks = [
    { id: 'F1 템플릿 토큰 누출', got: `${leak}줄${leakSamples.length ? ` (예: ${leakSamples[0]})` : ''}`, ok: leak === 0, want: '0줄' },
    { id: 'F2 근접 5줄 재등장', got: `${repeatPct.toFixed(1)}%${repeatSamples.length ? ` (예: ${repeatSamples[0].slice(0, 24)}…)` : ''}`, ok: repeatPct <= T.repeatPctMax, want: `≤${T.repeatPctMax}%` },
    { id: 'F3 고유 문장 비율', got: `${(distinctRatio * 100).toFixed(0)}%`, ok: distinctRatio >= T.distinctMin, want: `≥${(T.distinctMin * 100).toFixed(0)}%` },
    { id: 'F4 분당 줄 수', got: `${perMin.toFixed(1)}줄/분`, ok: perMin >= T.perMinMin && perMin <= T.perMinMax, want: `${T.perMinMin}~${T.perMinMax}줄/분` },
  ];
  // 토큰 누출은 치명 — 하나라도 있으면 M3 은 0.
  const s = leak > 0 ? 0 : checks.filter((c) => c.ok).length / checks.length;
  return { checks, score: s, raw: { leak, repeatPct, distinctRatio, perMin } };
}

// ── M4 게임 형태 ─────────────────────────────────────────────
function metricGame(none, good) {
  const realMin = (stc.pace?.matchRealSec || 210) / 60;
  const hlPer10 = mean(good.map((r) => r.hl)) / realMin * 10;
  const ptsNone = mean(none.map((r) => r.pts)), ptsGood = mean(good.map((r) => r.pts));
  const gdNone = mean(none.map((r) => r.gf - r.ga)), gdGood = mean(good.map((r) => r.gf - r.ga));
  const delta = ptsGood - ptsNone;
  const T = REF.game;
  const checks = [
    { id: 'G1 실플레이 시간', got: `${realMin.toFixed(1)}분`, ok: realMin >= T.realMinMin && realMin <= T.realMinMax, want: `${T.realMinMin}~${T.realMinMax}분` },
    { id: 'G2 분기점 밀도', got: `${hlPer10.toFixed(1)}회/10분`, ok: hlPer10 >= T.branchPer10Min && hlPer10 <= T.branchPer10Max, want: `${T.branchPer10Min}~${T.branchPer10Max}회/10분` },
    // 밴드인 이유: 델타가 0 이면 카드는 장식, 너무 크면 "카드만 내면 이긴다" = 축구가 아니라 슬롯머신.
    { id: 'G3 개입 델타(승점)', got: `+${delta.toFixed(2)} (무개입 ${ptsNone.toFixed(2)} → 개입 ${ptsGood.toFixed(2)}, n=${none.length}×2)`, ok: delta >= T.deltaPtsMin && delta <= T.deltaPtsMax, want: `+${T.deltaPtsMin}~+${T.deltaPtsMax}` },
    { id: 'G4 개입 델타(득실)', got: `${(gdGood - gdNone >= 0 ? '+' : '')}${(gdGood - gdNone).toFixed(2)}`, ok: gdGood - gdNone >= T.deltaGdMin && gdGood - gdNone <= T.deltaGdMax, want: `+${T.deltaGdMin}~+${T.deltaGdMax}` },
  ];
  return { checks, score: checks.filter((c) => c.ok).length / checks.length,
    raw: { realMin, hlPer10, ptsNone, ptsGood, delta, gdNone, gdGood } };
}

// ── 실행 ─────────────────────────────────────────────────────
const reg = [];
for (let s = 1; s <= N_MATCH; s++) reg.push(runRegulation(s));
const playGood = [], playNone = [];
for (let s = 1; s <= N_DELTA; s++) { playNone.push(runPlayable(s, 'none')); playGood.push(runPlayable(s, 'good')); }

const M1 = metricSpace(reg), M2 = metricStats(reg), M3 = metricFeed(playGood), M4 = metricGame(playNone, playGood);
const total = (M1.score + M2.score + M3.score + M4.score) / 4;
const PASS = M1.score === 1 && M2.score >= 1 && M3.score === 1 && M4.score === 1;

if (JSON_OUT) {
  console.log(JSON.stringify({
    m1: M1.score, m2: M2.score, m3: M3.score, m4: M4.score, total, pass: PASS,
    space: M1.raw, statsDevSum: M2.devSum,
    statRows: M2.rows.map((r) => ({ name: r.name, got: +r.got.toFixed(2), want: r.want, dev: +r.dev.toFixed(3) })),
    feed: M3.raw, game: M4.raw,
    matches: N_MATCH, deltaMatches: N_DELTA,
  }));
} else {
  const line = (c) => `  ${c.ok ? '✓' : '✗'} ${c.id.padEnd(22)} ${String(c.got).padEnd(46)} 목표 ${c.want}`;
  console.log(`축구다움 눈금 — 정규 ${N_MATCH}경기 · 개입 델타 ${N_DELTA}경기×2\n`);
  console.log(`M1 공간 ${(M1.score * 100).toFixed(0)}%`); M1.checks.forEach((c) => console.log(line(c)));
  console.log(`\nM2 통계 ${(M2.score * 100).toFixed(0)}%  (편차합 ${M2.devSum.toFixed(2)}, 목표 ≤${REF.thresholds.devSumGood})`);
  for (const r of M2.rows) console.log(`  ${r.dev <= 0.25 ? '✓' : '✗'} ${r.name.padEnd(12)} ${r.got.toFixed(2).padStart(8)}   기준 ${String(r.want).padStart(6)}   편차 ${(r.dev * 100).toFixed(0)}%`);
  console.log(`\nM3 중계 ${(M3.score * 100).toFixed(0)}%`); M3.checks.forEach((c) => console.log(line(c)));
  console.log(`\nM4 게임형태 ${(M4.score * 100).toFixed(0)}%`); M4.checks.forEach((c) => console.log(line(c)));
  console.log(`\n종합 ${(total * 100).toFixed(1)}%  →  ${PASS ? '✅ 도달' : '❌ 미달'}`);
}
process.exit(PASS ? 0 : 1);
