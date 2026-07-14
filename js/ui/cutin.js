// 연출 오버레이 (계획서 §9): 배너(1.5초)와 풀 컷인. 큰 타이포 + 단색 배경이면 충분하다.
// 모든 연출은 클릭 스킵 가능.

let fullTimer = null;
let bannerTimer = null;

export function showFullCutin({ title, sub }, seconds, mood, onDone) {
  const el = document.getElementById("cutin");
  el.querySelector(".cutin-title").textContent = title;
  el.querySelector(".cutin-sub").textContent = sub ?? "";
  el.className = `cutin-mood-${mood}`;
  el.classList.remove("hidden");

  const finish = () => {
    if (fullTimer) { clearTimeout(fullTimer); fullTimer = null; }
    el.classList.add("hidden");
    el.onclick = null;
    onDone && onDone();
  };
  el.onclick = finish;
  fullTimer = setTimeout(finish, seconds * 1000);
}

export function showBanner(text, seconds, onDone) {
  const el = document.getElementById("banner");
  el.textContent = text;
  el.classList.remove("hidden");
  const finish = () => {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    el.classList.add("hidden");
    el.onclick = null;
    onDone && onDone();
  };
  el.onclick = finish;
  bannerTimer = setTimeout(finish, seconds * 1000);
}
