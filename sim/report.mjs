// 연출대 (goal-harness). 한 줄로 임의의 회차 산출물을 재현하고 파일로 굳힌다.
//   node sim/report.mjs --round 3 [--seed 3] [--policy good|none]
//
// 출력: .claude/loop/runs/round-<N>/
//   report.md        중계 피드 전문 + 통계 대조 + 공간 관측  (심판이 읽는 텍스트)
//   pitch-*.png      결정론 피치 스냅샷 6장                 (심판이 표적 이미지와 대조)
//   MANIFEST.json    재현 정보 + 산출물 해시 + 결정론 검증
//
// 거짓 성공 불가(§연출대):
//   (a) 출력 디렉터리를 먼저 완전히 비운다 — 직전 회차 산출물이 이번 회차 옆에 섞이지 않게.
//   (b) 같은 시드로 한 번 더 돌려 스코어·tickCount·피드 길이가 같은지 사후 확인. 다르면 종료코드 2.
//   (c) 스냅샷마다 '요청한 순간'과 '실제 포착한 순간'을 함께 기록. 못 잡은 조건은 missing 으로 남긴다.
//   종료코드 0=정상, 1=산출 실패(내 지시가 틀림), 2=비결정론(환경/엔진이 흔들림) — 둘을 구분해 보고한다.

import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createMatch, tick } from '../js/game/match.js';
import { selectStance, acceptAdvice, playSub } from '../js/game/stance.js';
import { renderPitch } from './pitchshot.mjs';
import { FIELD } from '../js/game/field.js';

const ROOT = new URL('..', import.meta.url).pathname;
const L = (p) => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));
const cfg = L('engine.json'), com = L('commentary.json'), stc = L('stance.json');
const REF = JSON.parse(readFileSync(join(ROOT, 'docs/reference/match_stats.json'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROUND = arg('--round', '0'), SEED = parseInt(arg('--seed', '3'), 10), POLICY = arg('--policy', 'good');
const OUT = join(ROOT, '.claude/loop/runs', `round-${ROUND}`);

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// ── 포착 조건: 심판이 봐야 할 여섯 순간 ─────────────────────
const SHOTS = [
  { id: 'kickoff', label: '킥오프 직후', when: (s) => s.tickCount >= 20 && s.phase === 'IN_PLAY' },
  { id: 'buildup', label: '빌드업 중(유저가 글을 읽는 구간)', when: (s) => s.seq?.mode === 'BUILDUP' && s.clockSeconds > 120 },
  { id: 'highlight', label: '하이라이트 중(분기점)', when: (s) => s.seq?.mode === 'HIGHLIGHT' && s.clockSeconds > 120 },
  { id: 'attacking-box', label: '공이 상대 박스 안', when: (s) => Math.abs(s.ball.position.x) > FIELD.halfLength - FIELD.penaltyBoxLength && Math.abs(s.ball.position.z) < FIELD.penaltyBoxHalfWidth },
  { id: 'after-goal', label: '득점 직후', when: (s) => s.eventLog.at(-1)?.type === 'GOAL' },
  { id: 'second-half', label: '후반', when: (s) => s.half === 2 && s.clockSeconds > (s.halfSeconds + 120) },
];

function play(seed, policy, capture) {
  const s = createMatch(seed, cfg, com, stc);
  const PICK = [['press', 'high'], ['mentality', 'attack'], ['line', 'up'], ['attack_zone', 'wing']];
  const pending = capture ? [...SHOTS] : [];
  const shots = [], space = { gk: [], crowd: [], width: [] };
  let i = 0, subs = 0;
  while (s.phase !== 'FULLTIME') {
    tick(s);
    if (policy === 'good' && s.stance) {
      if (s.advice) acceptAdvice(s, stc);
      else if (s.tickCount % 900 === 0) { const [g, o] = PICK[i++ % PICK.length]; selectStance(s, 'A', g, o, stc); }
      if (subs < 3 && s.half === 2 && s.tickCount % 1200 === 0) { if (playSub(s, ['fw', 'mf', 'df'][subs], stc).ok) subs++; }
    }
    if (s.tickCount % 15 === 0 && s.phase === 'IN_PLAY') {
      const alive = Object.values(s.players).filter((p) => !p.sentOff);
      const b = s.ball.position;
      for (const p of alive) if (p.role === 'GK') space.gk.push(Math.hypot(p.position.x + s.attackDirection[p.teamId] * FIELD.halfLength, p.position.z));
      space.crowd.push(alive.filter((p) => p.role !== 'GK' && Math.hypot(p.position.x - b.x, p.position.z - b.z) <= 10).length);
      const zs = alive.filter((p) => p.role !== 'GK').map((p) => p.position.z);
      space.width.push(Math.max(...zs) - Math.min(...zs));
    }
    for (let k = pending.length - 1; k >= 0; k--) {
      if (!pending[k].when(s)) continue;
      const spec = pending.splice(k, 1)[0];
      shots.push({ id: spec.id, label: spec.label, tick: s.tickCount, clock: s.clockSeconds,
        half: s.half, score: { ...s.score }, poss: s.possessionTeamId, png: renderPitch(s) });
    }
  }
  return { state: s, shots, space, missing: pending.map((p) => p.id) };
}

// ── 실행 ─────────────────────────────────────────────────────
const run = play(SEED, POLICY, true);
const s = run.state;

// (b) 결정론 사후 확인 — 같은 시드로 다시 돌려 일치하는지
const verify = play(SEED, POLICY, false).state;
const deterministic = verify.score.A === s.score.A && verify.score.B === s.score.B
  && verify.tickCount === s.tickCount && (verify.feed?.length ?? -1) === (s.feed?.length ?? -2);

// (a) 디렉터리를 먼저 비운다
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const ev = {};
for (const e of s.eventLog) ev[e.type] = (ev[e.type] || 0) + 1;
const st = s.stats ?? {};
const feed = s.feed ?? [];
const leaks = feed.filter((f) => /[{}#]/.test(f.text));
const realMin = (stc.pace?.matchRealSec || 210) / 60;

for (const sh of run.shots) writeFileSync(join(OUT, `pitch-${sh.id}.png`), sh.png);

const R = REF.match90, T = REF.space;
const row = (n, got, want, unit = '') => `| ${n} | **${typeof got === 'number' ? got.toFixed(2) : got}**${unit} | ${want} |`;

const md = `# 회차 ${ROUND} 산출물 — 시드 ${SEED} · 정책 ${POLICY}

> 재현: \`node sim/report.mjs --round ${ROUND} --seed ${SEED} --policy ${POLICY}\`
> 결정론 재확인: ${deterministic ? '통과 (같은 시드 두 판이 동일)' : '**실패 — 같은 시드가 다른 결과를 냈다. 이 산출물은 신뢰할 수 없다.**'}
> 못 포착한 순간: ${run.missing.length ? `**${run.missing.join(', ')}** (해당 상황이 경기에 없었거나 조건이 틀림)` : '없음'}

## 1. 이 경기가 어떻게 끝났나

**수원 ${s.score.A} : ${s.score.B} 인천** · 실플레이 ${realMin.toFixed(1)}분 · ${s.tickCount} 틱 · 중계 ${feed.length}줄

| 지표 | 이 경기 | 실제 축구(90분 환산) |
|---|---|---|
${row('슛', (ev.SHOT || 0), R.shots)}
${row('유효슈팅', (st.onTarget?.A ?? 0) + (st.onTarget?.B ?? 0), R.onTarget)}
${row('xG 합', (st.xg?.A ?? 0) + (st.xg?.B ?? 0), `슛×${R.xgPerShot}`)}
${row('코너', (st.corners?.A ?? 0) + (st.corners?.B ?? 0), R.corners)}
${row('파울', (ev.FOUL || 0), R.fouls)}
${row('오프사이드', (ev.OFFSIDE || 0), R.offsides)}
${row('패스', (ev.PASS || 0), R.passes)}

이 경기는 정규 90분이 아니라 실플레이 ${realMin.toFixed(1)}분 압축이다 — 위 '실제 축구' 열은 **방향**을 보라는 것이지 직접 비교값이 아니다.
정규 90분 대조는 \`node sim/realism-lint.mjs\` 가 따로 수행한다.

## 2. 판이 축구로 읽히는가 (공간 관측)

| 관측 | 이 경기 | 표적 기준 |
|---|---|---|
| GK ↔ 자기 골문 거리 | p95 ${pctl(run.space.gk, 0.95).toFixed(1)}m · 평균 ${mean(run.space.gk).toFixed(1)}m | p95 ≤${T.gkDistP95Max}m |
| 공 10m 안 필드 선수 | p95 ${pctl(run.space.crowd, 0.95)}명 · 평균 ${mean(run.space.crowd).toFixed(1)}명 | p95 ≤${T.crowdP95Max}명 |
| 전체 폭(z 스팬) | 중앙값 ${pctl(run.space.width, 0.5).toFixed(0)}m | ≥${T.widthMin}m |

스냅샷 ${run.shots.length}장이 이 디렉터리에 있다. **\`docs/reference/target-pitch.png\` 와 나란히 열어서** 대조하라.

${run.shots.map((sh) => `- \`pitch-${sh.id}.png\` — ${sh.label} · ${fmt(sh.clock)} ${sh.half === 1 ? '전반' : '후반'} · ${sh.score.A}:${sh.score.B} · 점유 ${sh.poss ?? '없음'}`).join('\n')}

## 3. 중계 텍스트 (유저가 읽는 것 전부)

템플릿 토큰 누출: **${leaks.length}줄**${leaks.length ? ` — 예: \`${leaks[0].text}\`` : ''}
밀도: **${(feed.length / realMin).toFixed(1)}줄/분** (기준 ${REF.feed.perMinMin}~${REF.feed.perMinMax})

\`\`\`
${feed.map((f) => `${fmt(f.t)} ${f.text}`).join('\n')}
\`\`\`

## 4. 분기점과 개입

하이라이트(분기점) ${ev.HIGHLIGHT_START || 0}회 · 스탠스 변경 ${ev.STANCE || 0}회 · 교체 ${ev.SUB || 0}회

전체 이벤트: ${Object.entries(ev).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}
`;

writeFileSync(join(OUT, 'report.md'), md);

const files = readdirSync(OUT).sort();
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify({
  round: ROUND, seed: SEED, policy: POLICY,
  gitRev: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })(),
  node: process.version,
  dataHashes: Object.fromEntries(['engine.json', 'commentary.json', 'stance.json']
    .map((f) => [f, sha(readFileSync(join(ROOT, 'data', f)))])),
  deterministic, missingShots: run.missing,
  result: { score: s.score, ticks: s.tickCount, feedLines: feed.length, tokenLeaks: leaks.length },
  shots: run.shots.map((x) => ({ id: x.id, requested: x.label, capturedAtTick: x.tick, clock: +x.clock.toFixed(1) })),
  files: files.map((f) => ({ f, sha: sha(readFileSync(join(OUT, f))) })),
}, null, 2));

console.log(`회차 ${ROUND} 산출물 → ${OUT}`);
console.log(`  스코어 ${s.score.A}:${s.score.B} · 중계 ${feed.length}줄 · 토큰누출 ${leaks.length} · 스냅샷 ${run.shots.length}/${SHOTS.length}`);
if (!deterministic) { console.error('  ✗ 비결정론: 같은 시드가 다른 결과 — 환경/엔진이 흔들렸다. 이 회차는 판정에 쓰지 마라.'); process.exit(2); }
if (run.missing.length) { console.error(`  ✗ 포착 실패: ${run.missing.join(', ')}`); process.exit(1); }
console.log('  ✓ 결정론·포착 모두 정상');
