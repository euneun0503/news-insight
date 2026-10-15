// 이슈데스크: 커뮤니티·SNS 반응이 큰 기사 후보 + 기관 보도자료 (키워드 랭킹 하위 메뉴)
// 데이터: data/issuedesk/index.json (날짜 목록) + data/issuedesk/YYYY-MM-DD.json
// 매일 오전 7시 기본 수집, '지금 다시 조회'는 GitHub Actions(issuedesk.yml)로 실행 후 이 화면에서 바로 갱신
import { esc, h, dotDate, toast, kstDateTime } from "./util.js";
import { canRunIssuedesk, runIssuedesk, issuedeskLastRun } from "./admin.js";
import { info } from "./info.js";

const CAT_COLOR = { 건강: "#0f9d74", "제약·바이오": "#0e7490", 문화: "#b7791f", 연예인: "#c2417f", 스포츠: "#ea580c", 이슈: "#2563eb" };
const TOP_N = 20; // 분야별 추천 상위 N건은 연한 회색 배경
const heat = (i) => (i.views || 0) / 10000 + (i.likes || 0) / 300 + (i.comments || 0) / 60;
const stars = (n) => "★".repeat(Math.max(0, Math.min(5, n || 0)));
const num = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("ko-KR"));
const kstISO = (off = 0) => new Date(Date.now() + 9 * 3600e3 + off * 864e5).toISOString().slice(0, 10);
// 신규 = 게시일(자료 날짜)이 어제 또는 오늘(한국시간)
const isNew = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d >= kstISO(-1) && d <= kstISO(0);
const safe = (u) => (/^https?:\/\//.test(u || "") ? u : "#");

async function getJSON(path) {
  try {
    const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    return r.ok ? r.json() : null;
  } catch { return null; }
}
const loadDocs = async (days) => (await Promise.all(days.map((d) => getJSON(`data/issuedesk/${d}.json`)))).map((doc, i) => doc && { ...doc, day: days[i] }).filter(Boolean);

function flatten(docs) {
  const issues = [], press = [], homes = {};
  for (const d of docs) {
    const mine = (d.items || []).map((i) => ({ ...i, day: d.day, _new: isNew(i.date || d.day) }));
    // 보고서(날짜)·분야별로 추천도 → 반응 순 상위 TOP_N 표시
    const byCat = {};
    mine.forEach((i) => (byCat[i.category] ||= []).push(i));
    Object.values(byCat).forEach((arr) => arr.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || heat(b) - heat(a)).slice(0, TOP_N).forEach((i) => (i._top = true)));
    issues.push(...mine);
    (d.press?.agencies || []).forEach((a) => {
      if (!homes[a.name]) homes[a.name] = a.home;
      (a.items || []).forEach((i) => press.push({ ...i, agency: a.name, home: a.home, day: d.day, _new: isNew(i.date) }));
    });
  }
  return { issues, press, homes };
}

let polling = null;

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
  const shownDocs = (await loadDocs(days)).sort((a, b) => (a.day < b.day ? 1 : -1));
  const { issues, press, homes } = flatten(shownDocs);

  let tab = ctx.q.tab === "press" ? "press" : "issue";
  let filter = "전체";
  const latest = shownDocs[0];
  const updated = idx.updatedAt ? kstDateTime(idx.updatedAt) : "";

  const wrap = h(`<div class="idk">
    ${fallback ? `<div class="ok-box">선택한 기간에는 이슈데스크 보고서가 없어 <b>가장 최근 보고서(${dotDate(days[0])})</b>를 보여줍니다.</div>` : ""}
    <div class="card">
      <div class="card-head"><div><h3>이슈데스크</h3><div class="sub">커뮤니티·SNS에서 반응이 큰 글과 기관 보도자료 중 기사로 쓸 만한 것 · 매일 오전 7시 수집${updated ? ` · 마지막 갱신 ${esc(updated)}` : ""}</div></div>
        <div class="tools"><div class="seg" id="idkTab"><button data-t="issue">커뮤니티 이슈</button><button data-t="press">보도자료</button></div><button class="btn sm primary" id="idkRun">지금 다시 조회</button></div></div>
      <div class="idk-run" id="idkRunMsg" hidden></div>
      ${latest?.note ? `<div class="idk-note">${esc(latest.note)}</div>` : ""}
      <div class="idk-dl"><span id="idkDlLabel">커뮤니티 이슈 엑셀</span><input class="input" type="date" id="idkFrom" min="${all[0]}" max="${all[all.length - 1]}" value="${days[days.length - 1]}"><span>~</span><input class="input" type="date" id="idkTo" min="${all[0]}" max="${all[all.length - 1]}" value="${days[0]}"><button class="btn sm" id="idkDlRange">기간 내려받기</button><button class="btn sm" id="idkDlAll">전체</button><span class="form-hint">보고서가 있는 날짜: ${dotDate(all[0])} ~ ${dotDate(all[all.length - 1])}</span></div>
      <div class="idk-chips" id="idkChips"></div>
      <div class="idk-legend"><span><i class="idk-dot new"></i>어제·오늘 자료</span><span><i class="idk-dot"></i>그 이전 자료 ${info("idkNew")}</span><span>★ 추천도 ${info("idkScore")}</span><span id="idkLegendExtra"></span></div>
      <div id="idkBody"></div>
    </div>
    <div class="idk-foot">추천도(★)는 반응 규모·새로움·확인 가능성·공익성을 본 데스크 판단입니다. '자동 수집' 표시 항목은 다시 조회로 추가된 글로, 기사 앵글이 아직 없습니다. 커뮤니티 글은 검증 전 제보이므로 기사화 전 원글·당사자·기관 확인이 필요합니다.</div>
  </div>`);
  el.append(wrap);
  const $w = (s) => wrap.querySelector(s);

  function chips(groups, counts, newCounts) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const totalNew = Object.values(newCounts).reduce((a, b) => a + b, 0);
    $w("#idkChips").innerHTML = ["전체", ...groups].map((g) => {
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
    $w("#idkLegendExtra").innerHTML = `<i class="idk-sw"></i>연한 회색 배경 = 분야별 추천 상위 ${TOP_N}건 ${info("idkTop")}`;
    const list = issues.filter((i) => filter === "전체" || i.category === filter).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (b._top ? 1 : 0) - (a._top ? 1 : 0) || (b.score || 0) - (a.score || 0) || heat(b) - heat(a)));
    if (!list.length) return ($w("#idkBody").innerHTML = `<div class="empty">해당 분야 항목이 없습니다.</div>`);
    $w("#idkBody").innerHTML = `<div class="idk-list">${list.map((i) => {
      const nums = [["조회", num(i.views)], ["추천", num(i.likes)], ["댓글", num(i.comments)]].filter((x) => x[1]).map((x) => `${x[0]} ${x[1]}`).join(" · ");
      const prs = (i.press || []).map((p) => `<a href="${esc(safe(p.url))}" target="_blank" rel="noopener">${esc(p.title)}</a>`).join("");
      return `<article class="idk-item ${i._new ? "" : "old"} ${i._top ? "top" : ""}">
        <div class="idk-top"><span class="idk-cat" style="color:${CAT_COLOR[i.category] || "var(--muted)"}">${esc(i.category)}</span><span class="idk-src">${esc(i.source || "")}</span><span class="idk-src">${dotDate(i.date || i.day)}${i.date_note ? " (게시일 미확인)" : ""}</span>${i.auto ? '<span class="idk-pill auto">자동 수집</span>' : i.covered ? '<span class="idk-pill cov">기보도·후속</span>' : '<span class="idk-pill">미보도 추정</span>'}${i._top ? '<span class="idk-pill top" title="이 분야에서 추천도(★)가 높은 상위 20건">분야 추천 상위</span>' : ""}<span class="idk-score">${stars(i.score)}</span></div>
        <h4><i class="idk-dot ${i._new ? "new" : ""}"></i><a href="${esc(safe(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h4>
        ${nums ? `<div class="idk-nums num">${nums}</div>` : ""}
        ${i.auto ? "" : `<dl><dt>기사 앵글</dt><dd>${esc(i.angle || "")}</dd>${i.check ? `<dt>확인할 것</dt><dd>${esc(i.check)}</dd>` : ""}${prs ? `<dt>관련 보도</dt><dd class="idk-press">${prs}</dd>` : ""}</dl>`}
      </article>`;
    }).join("")}</div>`;
  }

  function drawPress() {
    const groups = [...new Set(press.map((i) => i.agency))];
    const counts = {}, nc = {};
    press.forEach((i) => { counts[i.agency] = (counts[i.agency] || 0) + 1; if (i._new) nc[i.agency] = (nc[i.agency] || 0) + 1; });
    chips(groups, counts, nc);
    $w("#idkLegendExtra").textContent = "기관 버튼의 빨간 선은 어제·오늘 자료가 있다는 뜻";
    const show = groups.filter((g) => filter === "전체" || g === filter);
    if (!show.length) return ($w("#idkBody").innerHTML = `<div class="empty">보도자료가 없습니다.</div>`);
    $w("#idkBody").innerHTML = show.map((g) => {
      const items = press.filter((i) => i.agency === g).sort((a, b) => (b._new - a._new) || ((b.date || "") > (a.date || "") ? 1 : (b.date || "") < (a.date || "") ? -1 : 0) || (b.score || 0) - (a.score || 0));
      return `<section class="idk-agency"><div class="idk-agency-head"><h4>${esc(g)}</h4>${homes[g] ? `<a href="${esc(safe(homes[g]))}" target="_blank" rel="noopener">기관 원문 게시판 ↗</a>` : ""}</div>
        ${items.map((i) => `<div class="idk-pr ${i._new ? "" : "old"}"><div class="idk-pr-t"><i class="idk-dot ${i._new ? "new" : ""}"></i><a href="${esc(safe(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
          <div class="idk-nums">${[i.date, i.source, i.score ? stars(i.score) : ""].filter(Boolean).map(esc).join(" · ")}</div>${i.angle ? `<div class="idk-pr-a">${esc(i.angle)}</div>` : ""}</div>`).join("")}</section>`;
    }).join("");
  }

  function draw() {
    wrap.querySelectorAll("#idkTab button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
    $w("#idkDlLabel").textContent = tab === "press" ? "보도자료 엑셀" : "커뮤니티 이슈 엑셀";
    tab === "press" ? drawPress() : drawIssues();
  }
  wrap.querySelectorAll("#idkTab button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; filter = "전체"; ctx.setQuery({ tab: tab === "press" ? "press" : "" }); draw(); }));

  // ── 엑셀: 기간 / 전체 ──
  async function exportDays(list) {
    if (!list.length) return toast("고른 기간에 보고서가 없습니다");
    const docs = (await loadDocs(list)).sort((a, b) => (a.day < b.day ? -1 : 1));
    const f = flatten(docs);
    const span = list.length > 1 ? `${list[0]}~${list[list.length - 1]}` : list[0];
    const sheets = [
      { name: "커뮤니티 이슈", rows: f.issues.map((i) => ({ 보고서날짜: i.day, 게시일: i.date || "", 신규: i._new ? "신규" : "", 추천상위: i._top ? "상위" : "", 분야: i.category, 추천도: i.score, 제목: i.title, 출처: i.source, 조회: i.views ?? "", 추천: i.likes ?? "", 댓글: i.comments ?? "", 구분: i.auto ? "자동 수집" : i.covered ? "기보도" : "미보도 추정", 기사앵글: i.auto ? "" : i.angle, 확인할것: i.check || "", 링크: i.url, 관련보도: (i.press || []).map((p) => `${p.title} ${p.url}`).join(" | ") })) },
      { name: "보도자료", rows: f.press.map((i) => ({ 보고서날짜: i.day, 자료일자: i.date || "", 신규: i._new ? "신규" : "", 기관: i.agency, 추천도: i.score, 제목: i.title, 출처: i.source || "", 기사앵글: i.angle || "", 링크: i.url, 기관게시판: i.home || "" })) },
    ];
    // 지금 보고 있는 탭의 시트만 내려받기
    ctx.exportSheets(`이슈데스크_${tab === "press" ? "보도자료" : "커뮤니티이슈"}_${span}`, [tab === "press" ? sheets[1] : sheets[0]]);
  }
  $w("#idkDlRange").addEventListener("click", () => {
    let a = $w("#idkFrom").value, b = $w("#idkTo").value;
    if (!a || !b) return toast("시작일과 끝 날짜를 골라 주세요");
    if (a > b) [a, b] = [b, a];
    exportDays(all.filter((d) => d >= a && d <= b));
  });
  $w("#idkDlAll").addEventListener("click", () => exportDays(all));

  // ── 지금 다시 조회: 실행 → 완료되면 이 화면에서 바로 갱신 ──
  const runBtn = $w("#idkRun"), msg = $w("#idkRunMsg");
  const say = (html, kind = "") => { msg.hidden = false; msg.className = `idk-run ${kind}`; msg.innerHTML = html; };
  if (!canRunIssuedesk()) runBtn.title = "로그인한 계정만 다시 조회할 수 있습니다";
  runBtn.addEventListener("click", async () => {
    if (!canRunIssuedesk()) return toast("로그인한 계정만 다시 조회할 수 있습니다", 2500);
    runBtn.disabled = true;
    const before = idx.updatedAt || "";
    const started = Date.now();
    try {
      await runIssuedesk();
    } catch (e) {
      runBtn.disabled = false;
      return say(esc(e.message), "err");
    }
    say('<span class="spin"></span>다시 조회 중입니다. 커뮤니티 인기글을 모은 뒤 사이트에 반영되기까지 2~4분쯤 걸립니다. 이 화면을 열어 두면 끝나는 대로 자동으로 바뀝니다.');
    clearInterval(polling);
    polling = setInterval(async () => {
      const now = await getJSON("data/issuedesk/index.json");
      if (now?.updatedAt && now.updatedAt !== before) {
        clearInterval(polling);
        toast("이슈데스크를 새로 고쳤습니다");
        if (location.hash.startsWith("#/issuedesk")) window.dispatchEvent(new HashChangeEvent("hashchange"));
        return;
      }
      let run = null;
      try { run = await issuedeskLastRun(); } catch {}
      if (run && run.status === "completed" && run.conclusion !== "success" && new Date(run.created_at).getTime() > started - 60e3) {
        clearInterval(polling); runBtn.disabled = false;
        return say(`다시 조회가 실패했습니다. <a href="${esc(run.html_url)}" target="_blank" rel="noopener">실행 기록 보기</a>`, "err");
      }
      if (run && run.status === "completed" && run.conclusion === "success") say('<span class="spin"></span>수집을 마쳤고 사이트에 반영하는 중입니다…');
      if (Date.now() - started > 12 * 60e3) {
        clearInterval(polling); runBtn.disabled = false;
        say("12분이 지나도 반영되지 않았습니다. 잠시 후 페이지를 새로 고쳐 보세요.", "err");
      }
    }, 15000);
  });

  draw();
}
