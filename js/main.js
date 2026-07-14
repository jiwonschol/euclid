// 컨트롤러: 엔진(순수)과 화면(렌더러/컷인/HUD)을 잇는다. 게임 규칙은 여기 두지 않는다.
import { Match } from "./engine/match.js";
import { createMotion, stepMotion } from "./engine/motion.js";
import { Renderer } from "./ui/renderer.js";
import { showFullCutin, showBanner } from "./ui/cutin.js";

const $ = (id) => document.getElementById(id);

let data, cfg, renderer;
let match = null;
let advisor = null;

const play = {
  ctx: null, motion: null,
  t: 0,
  phase: "idle", // idle | transition | playing | frozen | done
  paused: false, // 일시정지 (§5 재생 컨트롤) — 경기 시간·모션만 멈춘다 (카드는 낼 수 있다)
  holdUntil: 0, // 카드 관전 보장 하한 (§5 개정)
  resolved: null, cueDone: false, signalDone: false,
  speed: 1,
  stripLines: [],
  lastDebug: null,
};

// ── 부트스트랩 ──────────────────────────────────────────────
async function loadData() {
  const files = ["config", "formations", "scenes", "cards", "caster", "advisors"];
  const entries = await Promise.all(files.map(async (f) => {
    const res = await fetch(`data/${f}.json`);
    if (!res.ok) throw new Error(`data/${f}.json`);
    return [f, await res.json()];
  }));
  return Object.fromEntries(entries);
}

loadData()
  .then((d) => {
    data = d;
    cfg = d.config;
    renderer = new Renderer($("pitch"));
    setupSelectScreen();
    requestAnimationFrame(frame);
  })
  .catch((e) => {
    console.error(e);
    $("screen-error").classList.remove("hidden");
  });

// ── 참모 선택 ──────────────────────────────────────────────
function setupSelectScreen() {
  const wrap = $("advisor-choices");
  wrap.innerHTML = "";
  for (const a of data.advisors.advisors) {
    const el = document.createElement("div");
    el.className = "advisor-card";
    el.innerHTML = `<div class="face">${a.faces["0"].emoji}</div>
      <div class="name">${a.name}</div>
      <div class="tagline">${a.tagline}</div>`;
    el.onclick = () => { advisor = a; startMatch(); };
    wrap.appendChild(el);
  }
  $("screen-select").classList.remove("hidden");
}

// ── 경기 시작/재시작/중지 ───────────────────────────────────
function startMatch() {
  match = new Match(data, Math.floor(Math.random() * 2 ** 31));
  match.setAdvisor(advisor.id);
  $("screen-select").classList.add("hidden");
  $("screen-briefing").classList.add("hidden");
  $("screen-match").classList.remove("hidden");
  renderer.resize();
  play.phase = "idle";
  play.paused = false;
  $("btn-pause").textContent = "⏸";
  play.speed = cfg.defaultSpeed;
  play.stripLines = [];
  buildSpeedControls();
  buildCards();
  updateScoreboard();
  updateSidePanel();
  strip(match.kickoffLine());
  beginScene();
}

// 경기 중지 (§5 재생 컨트롤): 참모 선택으로 복귀. 이후 떠 있는 연출 타이머는 phase 가드가 무시한다.
function stopMatch() {
  play.phase = "done";
  play.paused = false;
  $("btn-pause").textContent = "⏸";
  $("screen-match").classList.add("hidden");
  $("screen-select").classList.remove("hidden");
}

function beginScene() {
  if (play.phase === "done") return; // 중지 후 떠 있던 연출 타이머 무시
  const info = match.beginScene();
  play.ctx = info;
  // 모션 상태 생성 (장면 시작 배치 포함, 계획서 §2.6). matchState는 읽기 전용으로 넘긴다.
  play.motion = createMotion(info.scene, data.formations, match.state, cfg);
  play.t = 0;
  play.holdUntil = 0; // 카드 관전 보장 하한 (§5 개정) — 이 장면에서 카드를 내면 갱신
  play.resolved = null;
  play.cueDone = false;
  play.signalDone = false;
  for (const t of info.arrivals) strip(t); // 지시 도착 텔레그래프 — 장면 서술보다 먼저 (§8-B)
  strip(info.narration);
  advisorIdle();
  updateScoreboard();
  updateSidePanel(); // 지시 도착이 여기서 적용되므로 '전달 중' 배지도 여기서 꺼져야 한다 (§8-B)

  // 하이라이트 컷 전환: 짧은 암전 + 경기 시간 → 새 장면은 이미 배치된 상태에서 시작
  play.phase = "transition";
  const el = $("scene-transition");
  el.querySelector(".st-minute").textContent = `${info.minuteStart}'`;
  el.classList.remove("hidden");
  setTimeout(() => {
    el.classList.add("hidden");
    play.phase = "playing";
  }, (cfg.sceneTransitionSec * 1000) / play.speed);
}

// ── 메인 루프 ──────────────────────────────────────────────
let lastTs = null;
let debugAccum = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastTs === null ? 0 : (ts - lastTs) / 1000;
  lastTs = ts;

  if (!play.paused && play.phase === "playing" && play.ctx) {
    const step = dt * play.speed;
    play.t += step;
    const { duration, signal } = play.ctx;

    if (!play.signalDone && signal && play.t >= signal.delayBeats * 2) {
      showSignal(signal);
      play.signalDone = true;
    }
    // 정보 선행 (§9): 판정은 연출보다 먼저, 단서(함성/탄식)만 먼저 출력
    if (!play.cueDone && play.t >= duration * cfg.outcomeCueLeadRatio) {
      play.resolved = match.resolveScene();
      if (play.resolved.debug) play.lastDebug = play.resolved.debug; // 흐름 장면은 PRD 판정이 없다
      if (play.resolved.cue) strip(play.resolved.cue);
      play.cueDone = true;
    }
    // 배속은 dt 스케일로 일괄 적용 — 모든 운동이 비율 유지한 채 빨라진다 (§2.6).
    // playing 페이즈에서만 스텝: transition(컷)·frozen(컷인)에는 마지막 배치를 그대로 그린다.
    stepMotion(play.motion, step);
    // 카드를 낸 직후엔 시퀀스를 잘라내지 않는다 — holdUntil까지는 마무리를 미룬다 (§5 개정)
    if (play.t >= duration && play.t >= play.holdUntil) concludeScene();
    updateClock();
  }

  if (play.motion && play.phase !== "done") {
    renderer.draw(play.motion.positions);
  }

  debugAccum += dt;
  if (debugAccum > 0.25) { debugAccum = 0; updateDebug(); }
}

// ── 장면 마무리: 3티어 연출 (§9) ───────────────────────────
function concludeScene() {
  play.phase = "frozen";
  const r = play.resolved;
  strip(r.line);
  const after = () => {
    if (r.judgment) strip(r.judgment);
    aftermath();
  };
  if (r.tier === 3 && r.fullCutin) {
    const mood = r.event.type === "goal" ? (r.event.side === "home" ? "home" : "away") : "neutral";
    showFullCutin(r.fullCutin, cfg.cutin.fullSec / play.speed, mood, after);
  } else if (r.tier === 2) {
    showBanner(r.line, cfg.cutin.bannerSec / play.speed, after);
  } else {
    setTimeout(after, (cfg.cutin.messageSec * 1000) / play.speed);
  }
}

function aftermath() {
  if (play.phase === "done") return; // 중지 후 떠 있던 연출 타이머 무시
  updateScoreboard();
  updateSidePanel();
  const fin = match.finishScene();
  for (const b of fin.benchChanges) strip(b.line); // 상대 벤치의 움직임은 숨기지 않는다 (§8)

  if (fin.phase === "halftime") {
    strip(fin.line);
    if (fin.foreshadow) strip(fin.foreshadow); // 후반 첫 장면 예고 (§8-C)
    showFullCutin(fin.fullCutin, cfg.cutin.fullSec / play.speed, "neutral", () => {
      updateSidePanel();
      beginScene();
    });
  } else if (fin.phase === "fulltime") {
    strip(fin.line);
    showFullCutin(fin.fullCutin, cfg.cutin.fullSec / play.speed, "neutral", showBriefing);
  } else {
    if (fin.foreshadow) strip(fin.foreshadow); // 컴퓨터의 퀴즈 — 다음 장면 예고 (§8-C)
    beginScene();
  }
}

// ── 카드 (§8) ──────────────────────────────────────────────
// 카드 위에서 비용·도착 시간·리스크가 읽혀야 한다 (§5 개정 — 카드 게임의 직관)
function deliveryLabel(card) {
  const n = card.delivery?.scenes ?? 0;
  return n === 0 ? "즉시" : n === 1 ? "다음 장면 도착" : `${n}장면 뒤 도착`;
}

function buildCards() {
  const wrap = $("cards");
  wrap.innerHTML = "";
  for (const card of data.cards.cards) {
    const block = document.createElement("div");
    block.className = "card-block";
    block.dataset.card = card.id;
    const opts = card.options
      ? card.options.map((o) => `<button data-choice="${o.value}">${o.label}</button>`).join("")
      : `<button data-choice="">${card.name}</button>`;
    const cost = card.costsToken ? "● 개입권 1" : "교체권";
    block.innerHTML = `
      <div class="card-head"><span class="card-title">${card.name}</span><span class="card-cost">${cost}</span></div>
      <div class="card-opts">${opts}</div>
      <div class="card-info"><b>${deliveryLabel(card)}</b> · ${card.risk}</div>`;
    block.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => onCard(card.id, btn.dataset.choice || null);
    });
    wrap.appendChild(block);
  }
}

function onCard(cardId, choice) {
  if (play.phase !== "playing") return; // 연출 중에는 발동 불가 (일시정지 중에는 가능 — 생각 시간)
  const r = match.playCard(cardId, choice);
  if (!r.ok) { strip(`— ${r.reason}`); return; }

  // §5 개정 (2026-07-14): 카드 발동은 경기를 멈추지 않는다 — 패를 놓으면(플래시+한 줄)
  // 경기는 계속 흐르고, 효과는 §8-B 스케줄대로 도착한다.
  const card = data.cards.cards.find((c) => c.id === cardId);
  const label = card.options?.find((o) => o.value === choice)?.label;
  strip(`⚑ ${card.name}${label ? ` — ${label}` : ""} 지시!`);
  for (const b of r.benchChanges) strip(b.line);
  if (r.deliveryScenes > 0) { // 발동≠도착 — 전달 중임을 숨기지 않는다 (§8-B)
    strip(`— 지시가 그라운드로 전달되고 있습니다 (${r.deliveryScenes === 1 ? "다음 장면" : `${r.deliveryScenes}장면 뒤`}부터)`);
  }
  const block = document.querySelector(`.card-block[data-card="${cardId}"]`);
  if (block) { block.classList.remove("played"); void block.offsetWidth; block.classList.add("played"); }
  updateSidePanel();

  // 진행 중인 시퀀스는 보여줄 만큼 보여준다 (§5 개정): 카드를 늦게 냈어도 최소 관전 시간을 보장.
  // 장면 원래 길이를 넘겨도 postCardMaxExtendSec까지만 — 웨이포인트 과다 오버런 방지.
  const cap = play.ctx.duration + (cfg.postCardMaxExtendSec ?? 3);
  play.holdUntil = Math.max(play.holdUntil, Math.min(cap, play.t + (cfg.postCardWatchSec ?? 3)));
}

// ── HUD ────────────────────────────────────────────────────
function strip(text) {
  if (!text) return;
  play.stripLines.push(text);
  const n = play.stripLines.length;
  $("strip-l1").textContent = n > 1 ? play.stripLines[n - 2] : "";
  $("strip-l2").textContent = play.stripLines[n - 1];
}

function updateScoreboard() {
  $("score").textContent = `${match.state.score[0]} : ${match.state.score[1]}`;
}

function updateClock() {
  const { minuteStart, minuteEnd, duration } = play.ctx;
  const m = Math.floor(minuteStart + (minuteEnd - minuteStart) * Math.min(1, play.t / duration));
  $("clock").textContent = `${m}'`;
}

function buildSpeedControls() {
  const wrap = $("speed-controls");
  wrap.innerHTML = "";
  for (const s of cfg.speeds) {
    const btn = document.createElement("button");
    btn.textContent = `${s}x`;
    btn.className = s === play.speed ? "active" : "";
    btn.onclick = () => {
      play.speed = s;
      wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    };
    wrap.appendChild(btn);
  }
}

function updateSidePanel() {
  const s = match.state;
  const maxDots = cfg.interventionsPerHalf * 2;
  $("tokens").textContent = `개입권 ${"●".repeat(Math.min(s.tokens, maxDots))}${"○".repeat(Math.max(0, maxDots - s.tokens))}`;
  $("subs").textContent = `교체 ${s.subsLeft}회`;

  const proj = match.projectedTeam(); // 발동 가능 판정은 대기 지시 포함 예상 상태 기준 (§8-B)
  for (const block of document.querySelectorAll(".card-block")) {
    const cardId = block.dataset.card;
    const card = data.cards.cards.find((c) => c.id === cardId);
    block.classList.toggle("pending", s.pendingDirectives.some((p) => p.cardId === cardId));
    block.querySelectorAll("button").forEach((btn) => {
      const choice = btn.dataset.choice;
      let disabled = card.costsToken && s.tokens <= 0;
      if (cardId === "line_adjust") {
        if (choice === "up" && proj.lineHeight === "high") disabled = true;
        if (choice === "down" && proj.lineHeight === "low") disabled = true;
      }
      if (cardId === "tactic") btn.classList.toggle("current", choice === s.tactic);
      btn.classList.toggle("queued", s.pendingDirectives.some((p) => p.cardId === cardId && p.choice === choice));
      if (cardId === "substitution" && s.subsLeft <= 0) disabled = true;
      btn.disabled = disabled;
    });
  }
}

// ── 참모 (§10) ─────────────────────────────────────────────
function advisorIdle() {
  $("advisor-face").textContent = advisor.faces["0"].emoji;
  $("advisor-face").className = "";
  $("advisor-name").textContent = advisor.name;
  const hint = $("advisor-hint");
  hint.className = "";
  hint.textContent = Math.random() < 0.3
    ? advisor.idleLines[Math.floor(Math.random() * advisor.idleLines.length)]
    : "";
}

function showSignal(signal) {
  const face = advisor.faces[String(signal.level)] ?? advisor.faces["0"];
  $("advisor-face").textContent = face.emoji;
  $("advisor-face").className = `sig-${signal.level}`;
  const hint = $("advisor-hint");
  hint.textContent = signal.text;
  hint.className = signal.level >= 3 ? "sig-3" : "";
}

// ── 브리핑 (§11) ───────────────────────────────────────────
function showBriefing() {
  play.phase = "done";
  const b = match.briefing();
  $("screen-match").classList.add("hidden");
  $("briefing-score").textContent = `수원 ${b.score[0]} : ${b.score[1]} 인천`;
  $("briefing-summary").textContent = `${advisor.name} — "${b.summary}"`;
  const wrap = $("briefing-items");
  wrap.innerHTML = "";
  for (const it of b.items) {
    const el = document.createElement("div");
    el.className = `briefing-item ${it.kind}`;
    el.textContent = it.text;
    wrap.appendChild(el);
  }
  $("screen-briefing").classList.remove("hidden");
}

$("btn-again").onclick = () => startMatch();

// ── 재생 컨트롤 (§5 개정: 상단 스코어보드) ──────────────────
$("btn-pause").onclick = () => {
  if (play.phase === "done" || play.phase === "idle") return;
  play.paused = !play.paused;
  $("btn-pause").textContent = play.paused ? "▶" : "⏸";
};
$("btn-stop").onclick = () => stopMatch();

// ── 디버그 (§9: 기본P/보정/실효P/주사위 상시 표시) ─────────
$("debug-toggle").onclick = () => $("debug").classList.toggle("hidden");

function updateDebug() {
  if ($("debug").classList.contains("hidden") || !match) return;
  const s = match.state;
  const d = play.lastDebug;
  const prdLine = d
    ? `장면 ${d.scene}\n표기P ${(d.statedP * 100).toFixed(1)}% | 시작C ${(d.baseC * 100).toFixed(1)}%\n` +
      `실패보정 +${(d.bonus * 100).toFixed(0)}%p (연속실패 ${d.failsBefore})\n` +
      `실효P ${(d.effP * 100).toFixed(1)}% | 주사위 ${(d.roll * 100).toFixed(1)} → ${d.roll < d.effP ? "성공" : "실패"}\n` +
      `카운터 적용: ${d.counterApplied}`
    : "(아직 판정 없음)";
  $("debug-pre").textContent =
    `${s.minute}' | ${s.score[0]}:${s.score[1]} | 모멘텀 ${s.momentum} | 사기 ${s.morale}\n` +
    `우리: 라인 ${s.lineHeight} / 전술 ${s.tactic} / 적응 ${s.adaptationLeft}\n` +
    `상대: 라인 ${s.opponent.lineHeight} / 전술 ${s.opponent.tactic}\n` +
    `개입권 ${s.tokens} | 교체 ${s.subsLeft} | 수적 ${s.manAdvantage}\n` +
    `PRD 연속실패 홈 ${s.prd.home.fails} / 상대 ${s.prd.away.fails}\n─── 최근 판정 ───\n${prdLine}`;
}

window.addEventListener("resize", () => renderer && renderer.resize());
