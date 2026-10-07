// 앱 진입점: 라우팅, 기간 필터, 보고서 내보내기
import { $, $$, esc, h, toast, kstToday, addDays, mmdd, weekday, kstDateTime, relTime, loadScript, setMediaColors, dateList, articleUrl } from "./util.js";
import { loadMeta, loadBoard, loadSettings, meta, mediaName, naverCoverage, Range, presetRange, rangeLabel, keywordTable, LIMITS } from "./data.js";
import { destroyCharts } from "./charts.js";
import * as V from "./views.js";
import { renderBanners, renderTicker, boardList, boardPost } from "./board.js";
import { adminPage, authState, can, loginGate, currentAcct, signOut, PAGE_PERMS } from "./admin.js";
import { setupInfo } from "./info.js";

const CFG = window.SITE_CONFIG || {};
const DATA_PAGES = { dashboard: V.dashboard, keywords: V.keywords, media: V.media, articles: V.articles, insights: V.insights, reporters: V.reporters };
const TITLES = { dashboard: "뉴스통계 (N)", keywords: "키워드 랭킹", media: "매체 비교", articles: "기사 목록", insights: "작성 인사이트", reporters: "기자 통계", board: "공지·게시판", admin: "관리자" };

let BOARD = { posts: [] };
let lastFinal = kstToday();
const rangeCache = new Map();
let renderSeq = 0;

// ── URL ────────────────────────────────
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const [page = "dashboard", ...rest] = path.split("/").filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(qs));
  return { page: page || "dashboard", param: rest.map(decodeURIComponent).join("/"), q };
}
function buildHash(page, q) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v != null)).toString();
  return `#/${page}${qs ? "?" + qs : ""}`;
}
function currentRange(q) {
  let s = q.s, e = q.e;
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  if (!ok(s) || !ok(e) || s > e) [s, e] = presetRange("yesterday", lastFinal); // 기본: 어제
  return { s, e };
}

// ── 기간 필터 ───────────────────────────
function setupFilter() {
  const M = meta();
  const ds = $("#dStart"), de = $("#dEnd");
  const today = kstToday();
  if (M.first) { ds.min = M.first; de.min = M.first; }
  ds.max = today; de.max = today;
  const apply = (s, e) => {
    if (!s || !e) return toast("시작일과 종료일을 입력해 주세요");
    if (s > e) return toast("시작일이 종료일보다 늦습니다");
    const { page, q } = parseHash();
    const target = DATA_PAGES[page] ? page : "dashboard";
    const keep = target === page ? q : {};
    location.hash = buildHash(target, { ...keep, s, e, k: "" });
  };
  $$("#presets button").forEach((b) =>
    b.addEventListener("click", () => {
      const [s, e] = presetRange(b.dataset.p, lastFinal);
      ds.value = s; de.value = e;
      apply(s, e);
    })
  );
  $("#btnApply").addEventListener("click", () => apply(ds.value, de.value));
  [ds, de].forEach((i) => i.addEventListener("keydown", (ev) => ev.key === "Enter" && apply(ds.value, de.value)));
  $("#btnReport").addEventListener("click", exportReport);
}

function syncFilter(r) {
  $("#dStart").value = r.s;
  $("#dEnd").value = r.e;
  $$("#presets button").forEach((b) => {
    const [s, e] = presetRange(b.dataset.p, lastFinal);
    b.classList.toggle("on", s === r.s && e === r.e);
  });
}

async function getRange(s, e) {
  const key = s + "|" + e;
  if (!rangeCache.has(key)) rangeCache.set(key, new Range(s, e).init());
  if (rangeCache.size > 12) rangeCache.delete(rangeCache.keys().next().value);
  return rangeCache.get(key);
}

// ── 렌더링 ──────────────────────────────
async function render() {
  const seq = ++renderSeq;
  const { page, param, q } = parseHash();
  destroyCharts();
  const view = $("#view");
  view.innerHTML = "";
  $("#sidebar").classList.remove("open");
  $$(".sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  document.title = `${TITLES[page] || "뉴스 인사이트"} · ${CFG.siteName || "뉴스 인사이트"}`;

  // 계정별 접속 권한: 허용되지 않은 메뉴는 첫 허용 메뉴로
  if (PAGE_PERMS[page] && !can(page)) {
    const first = Object.keys(PAGE_PERMS).find((k) => can(k));
    if (first && first !== page) { toast(`‘${TITLES[page]}’ 접근 권한이 없습니다`, 2500); location.hash = `#/${first}`; return; }
    if (!first) { view.innerHTML = '<div class="card"><div class="empty">볼 수 있는 메뉴가 없습니다. 마스터에게 권한을 요청하세요.</div></div>'; $("#filterbar").hidden = true; return; }
  }
  const isData = !!DATA_PAGES[page];
  $("#filterbar").hidden = !isData;
  renderBanners($("#bannerSlot"), BOARD, page === "dashboard" || (page === "board" && !param));

  const ctx = {
    q,
    board: BOARD,
    setBoard: (doc) => { BOARD = doc; renderTicker(BOARD); },
    link: (p, extra = {}) => {
      const { s, e } = currentRange(parseHash().q);
      return buildHash(p, { s, e, ...extra });
    },
    setQuery: (obj) => {
      const cur = parseHash();
      history.replaceState(null, "", buildHash(cur.page + (cur.param ? "/" + encodeURIComponent(cur.param) : ""), { ...cur.q, ...obj }));
    },
    exportSheets,
  };

  try {
    if (isData) {
      const r = currentRange(q);
      syncFilter(r);
      view.innerHTML = '<div class="loading">데이터 불러오는 중…</div>';
      const R = await getRange(r.s, r.e);
      if (seq !== renderSeq) return;
      view.innerHTML = "";
      const missing = R.n - Math.max(R.agg.rankDayCount, R.agg.pubDayCount);
      const M2 = meta();
      const lastRank = (M2.ranking_days || []).filter((d) => d <= R.e).pop();
      const endMissing = !(M2.ranking_days || []).includes(R.e);
      $("#rangeNote").innerHTML = `조회 기간: <b>${rangeLabel(R)}</b>${missing > 0 ? ` · <span class="warn">수집되지 않은 날 ${missing}일 포함</span>` : ""}${endMissing ? ` · <span class="warn">${R.e.replace(/-/g, ".")} 랭킹은 아직 수집 전${lastRank ? ` (가장 최근 수집: ${lastRank.replace(/-/g, ".")})` : ""}</span>` : ""}${R.n > LIMITS.articleDays ? ` · 기사 단위 목록은 ${LIMITS.articleDays}일(랭킹은 ${LIMITS.rankingDays}일) 이하에서 전체 제공` : ""}`;
      await DATA_PAGES[page](view, R, ctx);
    } else if (page === "board") {
      if (param) boardPost(view, BOARD, param);
      else boardList(view, BOARD, ctx);
    } else if (page === "admin") {
      await adminPage(view, ctx);
    } else {
      location.hash = "#/dashboard";
    }
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) view.innerHTML = `<div class="err-box">화면을 그리는 중 오류가 발생했습니다: ${esc(e.message)}</div>`;
  }
  window.scrollTo({ top: 0 });
}

// ── 엑셀 ────────────────────────────────
async function exportSheets(filename, sheets) {
  if (!can("download")) return toast("엑셀 다운로드 권한이 없습니다. 마스터에게 요청하세요.", 3000);
  try {
    toast("엑셀 만드는 중…");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    const X = window.XLSX;
    const wb = X.utils.book_new();
    for (const sh of sheets) {
      const ws = sh.aoa ? X.utils.aoa_to_sheet(sh.aoa) : X.utils.json_to_sheet(sh.rows.length ? sh.rows : [{ 안내: "데이터 없음" }]);
      const keys = sh.aoa ? sh.aoa[0] || [] : Object.keys(sh.rows[0] || {});
      ws["!cols"] = keys.map((k) => ({ wch: /제목/.test(k) ? 60 : /링크/.test(k) ? 44 : Math.max(8, String(k).length * 2 + 2) }));
      X.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
    }
    X.writeFile(wb, `${filename}.xlsx`);
    toast("엑셀을 저장했습니다");
  } catch (e) {
    toast("엑셀 저장 실패: " + e.message, 5000);
  }
}

async function exportReport() {
  if (!can("download")) return toast("엑셀 다운로드 권한이 없습니다. 마스터에게 요청하세요.", 4000);
  const { q } = parseHash();
  const r = currentRange(q);
  const R = await getRange(r.s, r.e);
  const A = R.agg;
  const M = meta();
  const P = (await R.previous()).agg;
  const our = M.our_media;
  const rankMedia = Object.keys(A.rank).sort((a, b) => A.rank[b].views - A.rank[a].views);
  const pubMedia = Object.keys(A.pub).sort((a, b) => A.pub[b] - A.pub[a]);
  const summary = [
    ["항목", "값"],
    ["조회 기간", `${R.s} ~ ${R.e} (${R.n}일)`],
    ["랭킹 수집일", `${A.rankDayCount}일`],
    ["발행 수집일", `${A.pubDayCount}일`],
    ["전체 발행 기사", A.pubTotal],
    ["랭킹 조회수 합", A.rankViews],
    [`${mediaName(our)} 랭킹 조회수`, A.rank[our]?.views ?? "-"],
    [`${mediaName(our)} 조회수 점유율`, A.rank[our] ? +(A.rank[our].views / A.rankViews * 100).toFixed(2) + "%" : "-"],
    [`${mediaName(our)} 랭킹 순위`, A.rank[our] ? `${rankMedia.indexOf(our) + 1} / ${rankMedia.length}` : "-"],
    [`${mediaName(our)} 발행 기사`, A.pub[our] ?? "-"],
    ["작성 시각", kstDateTime(new Date().toISOString())],
  ];
  const daily = R.days.map((d) => {
    const row = { 날짜: d, 요일: weekday(d) };
    for (const o of pubMedia) row[`${mediaName(o)}_발행`] = A.pubDay[d]?.[o] ?? "";
    for (const o of rankMedia) row[`${mediaName(o)}_랭킹조회수`] = A.rankDay[d]?.[o] ?? "";
    return row;
  });
  const mediaRows = [...new Set([...rankMedia, ...pubMedia])].map((o) => ({
    매체: mediaName(o), 발행기사: A.pub[o] ?? "", 일평균발행: A.pub[o] != null ? +(A.pub[o] / Math.max(1, A.pubDayCount)).toFixed(1) : "",
    랭킹조회수: A.rank[o]?.views ?? "", 직전기간조회수: P.rank[o]?.views ?? "", 점유율: A.rank[o] ? +(A.rank[o].views / A.rankViews * 100).toFixed(2) : "",
    랭킹기사평균조회수: A.rank[o] ? Math.round(A.rank[o].views / A.rank[o].n) : "",
  }));
  const kws = keywordTable(A, P.rankDayCount || P.pubDayCount ? P : null).sort((a, b) => b.score - a.score).slice(0, 300).map((k, i) => ({
    순위: i + 1, 키워드: k.word, 발행기사: k.pub, 랭킹진입: k.rank, 랭킹조회수: k.views, 종합점수: k.score, 직전기간점수: k.prev ?? "", 변화율: k.change == null ? (k.isNew ? "NEW" : "") : Math.round(k.change * 100) + "%",
  }));
  const rk = (await R.ranking()) || A.top;
  const rankRows = [...rk].sort((a, b) => b.views - a.views).map((a) => ({ 날짜: a.day, 매체: mediaName(a.oid), 순위: a.rank, 조회수: a.views, 제목: a.title, 기자: a.reporter || "", 발행일시: a.pub || "", 링크: articleUrl(a.oid, a.aid) }));
  const SR = await R.search();
  const searchRows = [...Object.entries(SR.volume).map(([w, [pc, mo, c]]) => ({ 검색어: w, 구분: SR.seeds.has(w) ? "관심" : "제목", PC: pc, 모바일: mo, 월간검색량: pc + mo, 기간발행: A.kw.get(w)?.pub ?? "" })),
    ...SR.related.map(([w, pc, mo, c, seed]) => ({ 검색어: w, 구분: "연관(" + seed + ")", PC: pc, 모바일: mo, 월간검색량: pc + mo, 기간발행: A.kw.get(w)?.pub ?? "" }))].sort((a, b) => b.월간검색량 - a.월간검색량);
  const trendRows = SR.google.map((x) => ({ 검색어: x.title, 최대검색량: x.traffic, 등장일수: x.days.length, 최근: x.days[x.days.length - 1], 관련뉴스: x.news[0]?.[0] || "", 링크: x.news[0]?.[1] || "" }));
  const reps = [...A.rep.values()].sort((a, b) => b.views - a.views).slice(0, 300).map((r) => ({ 기자: r.name, 매체: mediaName(r.oid), 발행: r.pub, 랭킹진입: r.rank, 랭킹조회수: r.views }));
  exportSheets(`뉴스인사이트_보고서_${R.s}_${R.e}`, [
    { name: "요약", aoa: summary },
    { name: "일별", rows: daily },
    { name: "매체별", rows: mediaRows },
    { name: "키워드", rows: kws },
    { name: "랭킹기사", rows: rankRows },
    { name: "기자", rows: reps },
    { name: "검색량", rows: searchRows },
    { name: "급상승검색어", rows: trendRows },
  ]);
}

// ── 상태 표시 ───────────────────────────
function renderStatus() {
  const M = meta();
  const pill = $("#statusPill");
  const run = M.last_run;
  if (!M.last) {
    pill.className = "status-pill bad";
    pill.lastElementChild.textContent = "수집된 데이터 없음 · 관리자 메뉴에서 수집을 실행하세요";
    return;
  }
  const hours = (Date.now() - new Date(run?.at || M.updated_at).getTime()) / 3600e3;
  pill.className = "status-pill " + (run && !run.ok ? "warn" : hours > 6 ? "warn" : "ok");
  pill.lastElementChild.textContent = `최근 수집 ${relTime(run?.at || M.updated_at)}${run && !run.ok ? ` · 경고 ${run.errors_n}` : ""} · 데이터 ~${(M.last || "").replace(/-/g, ".")}`;
  pill.title = kstDateTime(run?.at || M.updated_at);
  $("#navFoot").innerHTML = `우리 매체: <b>${esc(mediaName(M.our_media))}</b><br>${esc(naverCoverage().short)}<br>${M.first ? `${M.first.replace(/-/g, ".")} 부터 누적` : ""}<br>데이터 보관 ${M.retention_months || 24}개월`;
  $("#foot").innerHTML = `* 조회수는 네이버 언론사별 랭킹(상위 ${M.ranking_size || 20}건)에 표시된 값이며, 오늘 날짜는 하루가 끝날 때까지 바뀝니다. 발행 기사는 기사 상세페이지의 입력시각(한국시간) 기준으로 날짜를 확정합니다. 키워드는 제목에서 자동 추출한 단어 빈도로, 검색량과는 다른 지표입니다. 데이터 보관 기간은 ${M.retention_months || 24}개월이며, 지난 데이터는 오래된 것부터 자동 삭제됩니다.`;
}

// 계정 권한을 화면에 반영: 메뉴 숨김, 다운로드 버튼 숨김, 상단에 이름·로그아웃
function applyAccount(acct) {
  // 권한 없는 메뉴·버튼은 숨기지 않고 흐리게(비활성) + 누르면 '접근 권한이 없습니다' 미니 팝업
  $$(".sidebar a[data-page]").forEach((a) => {
    const locked = !!PAGE_PERMS[a.dataset.page] && !can(a.dataset.page);
    a.classList.toggle("locked", locked);
    a.setAttribute("aria-disabled", locked ? "true" : "false");
    if (locked) a.title = "접근 권한이 없습니다";
  });
  document.body.classList.toggle("no-dl", !can("download"));
  if (!applyAccount.bound) {
    applyAccount.bound = true;
    document.addEventListener("click", (e) => {
      const nav = e.target.closest(".sidebar a.locked");
      const dl = document.body.classList.contains("no-dl") && e.target.closest(".dl");
      if (!nav && !dl) return;
      e.preventDefault();
      e.stopPropagation();
      miniPop(nav || dl, nav ? "접근 권한이 없습니다" : "엑셀 다운로드 권한이 없습니다");
    }, true);
  }
  const chip = $("#userChip");
  if (!acct) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.innerHTML = `<a href="#/admin" title="내 정보·관리">${esc(acct.name)}${acct.role === "master" && acct.name !== "마스터" ? " · 마스터" : ""}</a><button type="button" id="signOut">로그아웃</button>`;
  $("#signOut", chip).addEventListener("click", signOut);
  const adm = $('.sidebar a[data-page="admin"]');
  if (adm && acct.role !== "master" && !can("posts") && !can("collect")) adm.lastChild.textContent = "내 계정";
}

// 요소 바로 옆에 잠깐 뜨는 작은 말풍선
function miniPop(el, msg) {
  document.querySelectorAll(".mini-pop").forEach((x) => x.remove());
  const r = el.getBoundingClientRect();
  const p = h(`<div class="mini-pop" role="status">🔒 ${esc(msg)}<span class="form-hint">마스터에게 권한을 요청하세요</span></div>`);
  document.body.append(p);
  const w = p.offsetWidth;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.bottom + 8 + p.offsetHeight > innerHeight ? r.top - p.offsetHeight - 8 : r.bottom + 8;
  p.style.left = left + "px";
  p.style.top = top + "px";
  setTimeout(() => p.classList.add("out"), 1800);
  setTimeout(() => p.remove(), 2200);
}

// ── 시작 ────────────────────────────────
async function boot() {
  $("#brandName").textContent = CFG.siteName || "뉴스 인사이트";
  $("#brandTag").textContent = CFG.siteTagline || "";
  $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  // 계정 확인: 마스터 계정이 만들어진 뒤에는 로그인한 사람만 볼 수 있음
  const auth = await authState();
  if (auth.configured && !auth.acct) {
    document.body.classList.add("gated");
    return loginGate($("#gate"), () => location.reload());
  }
  applyAccount(auth.acct);
  const [M, B] = await Promise.all([loadMeta(), loadBoard(), loadSettings()]);
  BOARD = B;
  setMediaColors(M);
  const today = kstToday();
  const finals = (M.ranking_days || []).filter((d) => d < today);
  // 기간 버튼은 항상 '실제 어제'(한국시간) 기준. 수집이 늦어진 날은 화면에 경고로 표시
  lastFinal = addDays(today, -1);
  renderStatus();
  renderTicker(BOARD);
  setupFilter();
  setupInfo();
  window.addEventListener("hashchange", render);
  render();
}

// 모듈 스크립트는 defer 스크립트(Chart.js) 다음에 실행되므로 바로 시작
boot();
