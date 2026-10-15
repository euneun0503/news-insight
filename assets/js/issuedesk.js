// 이슈데스크: 커뮤니티·SNS 반응이 큰 기사 후보 + 기관 보도자료 (키워드 랭킹 하위 메뉴)
// 데이터: data/issuedesk/index.json (날짜 목록) + data/issuedesk/YYYY-MM-DD.json
import { esc, h, dotDate } from "./util.js";

const CAT_COLOR = { 건강: "#0f9d74", 문화: "#b7791f", 연예인: "#c2417f", 이슈: "#2563eb" };
const stars = (n) => "★".repeat(Math.max(0, Math.min(5, n || 0)));
const num = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("ko-KR"));
const REFRESH_URL = "https://claude.ai/artifact/94ksDzk7vqqwB1KynRQpGc"; // 다시 조회는 Claude 보고서 페이지에서 실행
const kstISO = (off = 0) => new Date(Date.now() + 9 * 3600e3 + off * 864e5).toISOString().slice(0, 10);
// 신규 = 게시일(자료 날짜)이 어제 또는 오늘(한국시간)
const isNew = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d >= kstISO(-1) && d <= kstISO(0);
const safe = (u) => (/^https?:\/\//.test(u || "") ? u : "#");

async function getJSON(path) {
  try {
    const r = await fetch(`${path}?t=${Math.floor(Date.now() / 60000)}`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

export async function issuedesk(el, r, ctx) {
  const idx = await getJSON("data/issuedesk/index.json");
  const all = (idx?.days || []).slice().sort();
  if (!all.length) {
    el.append(h(`<div class="card"><div class="empty">아직 올라온 이슈데스크 보고서가 없습니다.</div></div>`));
    return;
  }
  let days = all.filter((d) => d >= r.s && d <= r.e);
  let fallback = false;
  if (!days.length) { days = [all[all.length - 1]]; fallback = true; }
  const docs = (await Promise.all(days.map((d) => getJSON(`data/issuedesk/${d}.json`)))).map((doc, i) => doc && { ...doc, day: days[i] }).filter(Boolean);
  const shownDocs = docs.sort((a, b) => (a.day < b.day ? 1 : -1));
  const issues = [], press = [];
  for (const d of shownDocs) {
    (d.items || []).forEach((i) => issues.push({ ...i, day: d.day, _new: isNew(i.date || d.day) }));
    (d.press?.agencies || []).forEach((a) => (a.items || []).forEach((i) => press.push({ ...i, agency: a.name, home: a.home, day: d.day, _new: isNew(i.date) })));
  }
  const homes = {};
  shownDocs.forEach((d) => (d.press?.agencies || []).forEach((a) => { if (!homes[a.name]) homes[a.name] = a.home; }));

  let tab = ctx.q.tab === "press" ? "press" : "issue";
  let filter = "전체";
  const latest = shownDocs[0];

  const wrap = h(`<div class="idk">
    ${fallback ? `<div class="ok-box">선택한 기간에는 이슈데스크 보고서가 없어 <b>가장 최근 보고서(${dotDate(days[0])})</b>를 보여줍니다.</div>` : ""}
    <div class="card">
      <div class="card-head"><div><h3>이슈데스크</h3><div class="sub">커뮤니티·SNS에서 반응이 큰 글과 기관 보도자료 중 기사로 쓸 만한 것 · 보고서 ${shownDocs.length}일치</div></div>
        <div class="tools"><div class="seg" id="idkTab"><button data-t="issue">커뮤니티 이슈</button><button data-t="press">보도자료</button></div><a class="btn sm" href="${REFRESH_URL}" target="_blank" rel="noopener" title="Claude 보고서 페이지에서 지금 다시 조회합니다. 끝나면 이 화면에도 반영됩니다.">지금 다시 조회 ↗</a><button class="btn sm" id="idkXls">엑셀</button></div></div>
      ${latest?.note ? `<div class="idk-note">${esc(latest.note)}</div>` : ""}
      <div class="idk-chips" id="idkChips"></div>
      <div class="idk-legend"><span><i class="idk-dot new"></i>어제·오늘 자료</span><span><i class="idk-dot"></i>그 이전 자료</span><span id="idkLegendExtra"></span></div>
      <div id="idkBody"></div>
    </div>
    <div class="idk-foot">추천도(★)는 반응 규모·새로움·확인 가능성·공익성을 본 데스크 판단입니다. 커뮤니티 글은 검증 전 제보이므로 기사화 전 원글·당사자·기관 확인이 필요합니다.</div>
  </div>`);
  el.append(wrap);

  function chips(groups, counts, newCounts) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const totalNew = Object.values(newCounts).reduce((a, b) => a + b, 0);
    wrap.querySelector("#idkChips").innerHTML = ["전체", ...groups].map((g) => {
      const n = g === "전체" ? total : counts[g] || 0, nn = g === "전체" ? totalNew : newCounts[g] || 0;
      return `<button class="idk-chip ${g === filter ? "on" : ""} ${tab === "press" && nn ? "has-new" : ""}" data-g="${esc(g)}">${esc(g)}<span class="n">${n}</span>${tab === "press" && nn ? `<span class="nn">신규 ${nn}</span>` : ""}</button>`;
    }).join("");
    wrap.querySelectorAll(".idk-chip").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.g; draw(); }));
  }

  function drawIssues() {
    const groups = Object.keys(CAT_COLOR).filter((c) => issues.some((i) => i.category === c)).concat([...new Set(issues.map((i) => i.category))].filter((c) => !CAT_COLOR[c]));
    const counts = {}, nc = {};
    issues.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; if (i._new) nc[i.category] = (nc[i.category] || 0) + 1; });
    chips(groups, counts, nc);
    wrap.querySelector("#idkLegendExtra").textContent = "";
    const list = issues.filter((i) => filter === "전체" || i.category === filter).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (b.score || 0) - (a.score || 0)));
    if (!list.length) return (wrap.querySelector("#idkBody").innerHTML = `<div class="empty">해당 분야 항목이 없습니다.</div>`);
    wrap.querySelector("#idkBody").innerHTML = `<div class="idk-list">${list.map((i) => {
      const nums = [["조회", num(i.views)], ["추천", num(i.likes)], ["댓글", num(i.comments)]].filter((x) => x[1]).map((x) => `${x[0]} ${x[1]}`).join(" · ");
      const press = (i.press || []).map((p) => `<a href="${esc(safe(p.url))}" target="_blank" rel="noopener">${esc(p.title)}</a>`).join("");
      return `<article class="idk-item ${i._new ? "" : "old"}">
        <div class="idk-top"><span class="idk-cat" style="color:${CAT_COLOR[i.category] || "var(--muted)"}">${esc(i.category)}</span><span class="idk-src">${esc(i.source || "")}</span>${i.covered ? '<span class="idk-pill cov">기보도·후속</span>' : '<span class="idk-pill">미보도 추정</span>'}<span class="idk-src">${dotDate(i.date || i.day)}${i.date_note ? " (게시일 미확인)" : ""}</span><span class="idk-score">${stars(i.score)}</span></div>
        <h4><i class="idk-dot ${i._new ? "new" : ""}"></i><a href="${esc(safe(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h4>
        ${nums ? `<div class="idk-nums num">${nums}</div>` : ""}
        <dl><dt>기사 앵글</dt><dd>${esc(i.angle || "")}</dd>${i.check ? `<dt>확인할 것</dt><dd>${esc(i.check)}</dd>` : ""}${press ? `<dt>관련 보도</dt><dd class="idk-press">${press}</dd>` : ""}</dl>
      </article>`;
    }).join("")}</div>`;
  }

  function drawPress() {
    const groups = [...new Set(press.map((i) => i.agency))];
    const counts = {}, nc = {};
    press.forEach((i) => { counts[i.agency] = (counts[i.agency] || 0) + 1; if (i._new) nc[i.agency] = (nc[i.agency] || 0) + 1; });
    chips(groups, counts, nc);
    wrap.querySelector("#idkLegendExtra").textContent = "기관 버튼의 빨간 선은 신규 자료가 있다는 뜻";
    const show = groups.filter((g) => filter === "전체" || g === filter);
    if (!show.length) return (wrap.querySelector("#idkBody").innerHTML = `<div class="empty">보도자료가 없습니다.</div>`);
    wrap.querySelector("#idkBody").innerHTML = show.map((g) => {
      const items = press.filter((i) => i.agency === g).sort((a, b) => (b._new - a._new) || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (b.score || 0) - (a.score || 0));
      return `<section class="idk-agency"><div class="idk-agency-head"><h4>${esc(g)}</h4>${homes[g] ? `<a href="${esc(safe(homes[g]))}" target="_blank" rel="noopener">기관 원문 게시판 ↗</a>` : ""}</div>
        ${items.map((i) => `<div class="idk-pr ${i._new ? "" : "old"}"><div class="idk-pr-t"><i class="idk-dot ${i._new ? "new" : ""}"></i><a href="${esc(safe(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
          <div class="idk-nums">${[i.date, i.source, i.score ? stars(i.score) : ""].filter(Boolean).map(esc).join(" · ")}</div>${i.angle ? `<div class="idk-pr-a">${esc(i.angle)}</div>` : ""}</div>`).join("")}</section>`;
    }).join("");
  }

  function draw() {
    wrap.querySelectorAll("#idkTab button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
    tab === "press" ? drawPress() : drawIssues();
  }
  wrap.querySelectorAll("#idkTab button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; filter = "전체"; ctx.setQuery({ tab: tab === "press" ? "press" : "" }); draw(); }));

  wrap.querySelector("#idkXls").addEventListener("click", () => {
    const span = days.length > 1 ? `${days[0]}~${days[days.length - 1]}` : days[0];
    ctx.exportSheets(`이슈데스크_${span}`, [
      { name: "커뮤니티 이슈", rows: issues.map((i) => ({ 보고서날짜: i.day, 게시일: i.date || "", 신규: i._new ? "신규" : "", 분야: i.category, 추천도: i.score, 제목: i.title, 출처: i.source, 조회: i.views ?? "", 추천: i.likes ?? "", 댓글: i.comments ?? "", 기보도: i.covered ? "예" : "아니오", 기사앵글: i.angle, 확인할것: i.check || "", 링크: i.url, 관련보도: (i.press || []).map((p) => `${p.title} ${p.url}`).join(" | ") })) },
      { name: "보도자료", rows: press.map((i) => ({ 보고서날짜: i.day, 신규: i._new ? "신규" : "", 기관: i.agency, 추천도: i.score, 제목: i.title, 자료일자: i.date || "", 출처: i.source || "", 기사앵글: i.angle || "", 링크: i.url, 기관게시판: i.home || "" })) },
    ]);
  });
  draw();
}
