// 2D 피치 렌더러 (연속 엔진 전용). 미터 월드좌표(x∈[-52.5,52.5], z∈[-34,34]) → 캔버스 픽셀.
// 상태를 읽기만 한다(그리기 부작용 없음). 시뮬 좌표와 렌더 좌표를 이 파일에서만 변환(§3).

const F = {
  L: 105, W: 68, hl: 52.5, hw: 34,
  pboxL: 16.5, pboxHW: 20.16, gaL: 5.5, gaHW: 9.16,
  cr: 9.15, pspot: 11, goalHW: 3.66, goalDepth: 2,
};

const COL = {
  turf1: '#2f8f46', turf2: '#2b8341', line: 'rgba(255,255,255,0.78)',
  A: '#2f6bff', B: '#ff4d4d', gkA: '#ffd23b', gkB: '#38d9a9',
  ball: '#ffffff', ballEdge: '#111', carrier: '#ffffff', text: '#ffffff',
};

function layout(canvas) {
  const scale = Math.min((canvas.width - 24) / F.L, (canvas.height - 24) / F.W);
  const pw = F.L * scale, ph = F.W * scale;
  const ox = (canvas.width - pw) / 2, oy = (canvas.height - ph) / 2;
  return { scale, ox, oy, pw, ph, toPx: (x, z) => [ox + (x + F.hl) * scale, oy + (z + F.hw) * scale] };
}

function drawPitch(ctx, L) {
  const { scale, ox, oy, pw, ph, toPx } = L;
  // 잔디 스트라이프
  const stripes = 12, sw = pw / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? COL.turf2 : COL.turf1;
    ctx.fillRect(ox + i * sw, oy, sw + 1, ph);
  }
  ctx.strokeStyle = COL.line; ctx.lineWidth = 2; ctx.fillStyle = COL.line;
  const rect = (x0, z0, x1, z1) => { const a = toPx(x0, z0), b = toPx(x1, z1); ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); };
  const line = (x0, z0, x1, z1) => { const a = toPx(x0, z0), b = toPx(x1, z1); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
  const dot = (x, z, r = 3) => { const a = toPx(x, z); ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, 7); ctx.fill(); };

  rect(-F.hl, -F.hw, F.hl, F.hw);                 // 경계
  line(0, -F.hw, 0, F.hw);                          // 하프라인
  const c = toPx(0, 0); ctx.beginPath(); ctx.arc(c[0], c[1], F.cr * scale, 0, 7); ctx.stroke(); dot(0, 0);
  for (const s of [-1, 1]) {                        // 양 끝 박스
    rect(s * F.hl, -F.pboxHW, s * (F.hl - F.pboxL), F.pboxHW);
    rect(s * F.hl, -F.gaHW, s * (F.hl - F.gaL), F.gaHW);
    dot(s * (F.hl - F.pspot), 0);
    rect(s * F.hl, -F.goalHW, s * (F.hl + F.goalDepth), F.goalHW); // 골문
  }
}

function drawPlayers(ctx, L, state, opts) {
  const { toPx } = L;
  const carrierId = state.ball?.carrierId;
  const presserId = state._press?.presserId;
  for (const p of Object.values(state.players)) {
    if (p.sentOff) continue;
    const [px, py] = toPx(p.position.x, p.position.z);
    const isGK = p.role === 'GK';
    const fill = isGK ? (p.teamId === 'A' ? COL.gkA : COL.gkB) : (p.teamId === 'A' ? COL.A : COL.B);
    const r = 9;
    if (p.id === presserId) { ctx.beginPath(); ctx.arc(px, py, r + 4, 0, 7); ctx.strokeStyle = '#ffdf6b'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fillStyle = fill; ctx.fill();
    if (p.id === carrierId) { ctx.strokeStyle = COL.carrier; ctx.lineWidth = 2.5; ctx.stroke(); }
    else { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = (isGK || p.teamId === 'B') ? '#111' : '#fff';
    ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(p.shirtNumber), px, py);
  }
}

function drawBall(ctx, L, state) {
  const b = state.ball; if (!b) return;
  const [px, py] = L.toPx(b.position.x, b.position.z);
  const lift = (b.position.y || 0);
  const r = 5 + Math.min(4, lift * 0.5);
  if (lift > 0.05) { // 공중볼 그림자
    ctx.beginPath(); ctx.ellipse(px, py + lift * 1.5, r * 0.9, r * 0.5, 0, 0, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(px, py - lift * 1.5, r, 0, 7);
  ctx.fillStyle = COL.ball; ctx.fill(); ctx.strokeStyle = COL.ballEdge; ctx.lineWidth = 1.2; ctx.stroke();
}

/** 한 프레임 그리기. view = {canvas, ctx}. */
export function draw(view, state, opts = {}) {
  const { ctx, canvas } = view;
  const L = layout(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawPitch(ctx, L);
  drawPlayers(ctx, L, state, opts);
  drawBall(ctx, L, state);
}

export function makeView(canvas) { return { canvas, ctx: canvas.getContext('2d') }; }
