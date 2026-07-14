// 정오각형 경로(중심 cx,cy·꼭짓점거리 rad·회전 rot 라디안). beginPath/fill은 호출부에서 — 축구공 패치용.
function pentPath(c, cx, cy, rad, rot) {
  for (let i = 0; i < 5; i++) {
    const a = rot + i * (2 * Math.PI / 5);
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

// 피치 렌더러. 상태를 갖지 않는다 — 매 프레임 positions를 받아 그릴 뿐이다 (계획서 §4).
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  // 피치 좌표(0-100) → 캔버스 픽셀
  px(p) {
    const mx = 24, my = 18;
    return [mx + (p[0] / 100) * (this.w - mx * 2), my + (p[1] / 100) * (this.h - my * 2)];
  }

  draw(positions, sentOff) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // 피치
    c.fillStyle = "#1d4a2a";
    c.fillRect(0, 0, this.w, this.h);
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.lineWidth = 1.5;
    const [x0, y0] = this.px([0, 0]);
    const [x1, y1] = this.px([100, 100]);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // 센터라인·서클
    const [cx, cy] = this.px([50, 50]);
    c.beginPath(); c.moveTo(cx, y0); c.lineTo(cx, y1); c.stroke();
    c.beginPath(); c.arc(cx, cy, (x1 - x0) * 0.08, 0, Math.PI * 2); c.stroke();
    // 페널티 박스
    for (const [bx, dir] of [[0, 1], [100, -1]]) {
      const [px0, py0] = this.px([bx, 24]);
      const [px1, py1] = this.px([bx + dir * 14, 76]);
      c.strokeRect(Math.min(px0, px1), py0, Math.abs(px1 - px0), py1 - py0);
    }
    // 골문
    c.fillStyle = "rgba(255,255,255,0.5)";
    for (const gx of [0, 100]) {
      const [gx0, gy0] = this.px([gx, 44]);
      const [, gy1] = this.px([gx, 56]);
      c.fillRect(gx0 - 3, gy0, 6, gy1 - gy0);
    }

    // 바둑알 22개
    const r = Math.max(7, (x1 - x0) * 0.013);
    for (const [id, p] of Object.entries(positions)) {
      if (id === "ball" || id === "ballZ") continue; // ballZ는 공 높이 스칼라, 알이 아니다
      const [sx, sy] = this.px(p);
      const isHome = id.startsWith("h");
      c.beginPath();
      c.arc(sx, sy, r, 0, Math.PI * 2);
      c.fillStyle = isHome ? "#3b82f6" : "#ef4444";
      c.fill();
      if (id === "h1" || id === "a1") { // GK 링
        c.strokeStyle = "rgba(255,255,255,0.9)";
        c.lineWidth = 2;
        c.stroke();
      }
    }

    // 공: 축구공으로 그린다 — 흰 원 + 검은 오각형 패치(캔버스 기하, 이미지 금지) (계획서 §2.5).
    // ballZ(로프트 높이 0..1)로 반지름(1+0.9z)·그림자를 강화 — 상공 뷰에서 뜬 공이 카메라로 다가와
    // "커지는" 느낌을 확실히(v0.5 디자이너 지시). 지상 공(z≈0)도 같은 축구공, 그림자만 없다.
    if (positions.ball) {
      const [bx, by] = this.px(positions.ball);
      const z = positions.ballZ || 0;
      const rad = r * 0.55 * (1 + 0.9 * z);
      const lift = z * r * 1.9; // 높이만큼 위로 띄우고 그림자는 지면에 남긴다(분리 강화)
      if (z > 0.02) { // 로프트 그림자: 지면에 남고 z에 따라 오프셋·크기 확대 (계획서 §2.5)
        c.beginPath();
        c.ellipse(bx, by + rad * 0.15, rad * (1.15 + 0.7 * z), rad * (0.6 + 0.2 * z), 0, 0, Math.PI * 2);
        c.fillStyle = `rgba(0,0,0,${0.32 - 0.10 * z})`;
        c.fill();
      }
      const cxb = bx, cyb = by - lift;
      // 흰 구체
      c.beginPath();
      c.arc(cxb, cyb, rad, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      // 검은 오각형 패치: 중앙 1 + 림 5 (원 안으로 클립해 림 패치가 밖으로 새지 않게)
      c.save();
      c.beginPath();
      c.arc(cxb, cyb, rad, 0, Math.PI * 2);
      c.clip();
      c.fillStyle = "#111827";
      c.beginPath(); pentPath(c, cxb, cyb, rad * 0.42, -Math.PI / 2); c.fill(); // 중앙(꼭짓점 위)
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k + 0.5) * (2 * Math.PI / 5); // 중앙 꼭짓점 사이(변) 방향
        const px = cxb + Math.cos(a) * rad * 0.82, py = cyb + Math.sin(a) * rad * 0.82;
        c.beginPath(); pentPath(c, px, py, rad * 0.30, a + Math.PI / 2); c.fill(); // 안쪽 향한 림 패치
      }
      c.restore();
      // 외곽선
      c.beginPath();
      c.arc(cxb, cyb, rad, 0, Math.PI * 2);
      c.strokeStyle = "rgba(0,0,0,0.45)";
      c.lineWidth = 1;
      c.stroke();
    }
  }
}
