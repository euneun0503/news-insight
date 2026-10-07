// 분석 화면들
import { esc, fmt, fmt1, pct, short, h, $, $$, mmdd, weekday, dayKind, DAY_COLOR, holiday, articleUrl, mediaColor, sparkline, debounce, dotDate, kstDateTime, relTime, OUR_COLOR } from "./util.js";
import { meta, mediaName, keywordTable, kwScore, LIMITS, naverCoverage, mediaSel, Range, loadRankingDays } from "./data.js";
import { openMediaSettings } from "./mediasel.js";
import { adminForSettings, saveSeedGroups } from "./admin.js";
import { lineChart, barChart, comboChart, dayLabels } from "./charts.js";
import { boardTypeLabel, activeNotices } from "./board.js";
import { info } from "./info.js";

const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const kstTodayISO = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDaysISO = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const WD_NAME = "일월화수목금토";

const chip = (oid) => `<span class="media-chip"><i style="background:${mediaColor(oid)}"></i>${esc(mediaName(oid))}</span>`;
const isOur = (oid) => oid === meta().our_media;
function delta(cur, prev) {
  if (prev == null || !prev || cur == null) return "";
  const d = (cur - prev) / prev;
  if (!isFinite(d) || Math.abs(d) < 0.005) return `<span class="delta">0%</span>`;
  return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d * 100).toFixed(1)}%</span>`;
}
function canvas(cls = "") {
  return `<div class="chart-box ${cls}"><canvas></canvas></div>`;
}
function emptyBox(msg) {
  return `<div class="empty">${msg}</div>`;
}
function noData(R) {
  return `<div class="card">${emptyBox(`선택한 기간(${R.s} ~ ${R.e})에 수집된 데이터가 없습니다.<br>관리자 메뉴에서 수집을 실행하거나 기간을 바꿔 조회해 주세요.`)}</div>`;
}

// 페이지 번호 탭
function pagerHtml(page, pages, total) {
  const nums = [];
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 2) nums.push(i); else if (nums[nums.length - 1] !== "…") nums.push("…");
  return `<div class="pager">${page > 1 ? `<button class="btn sm pg-num" data-p="${page - 1}">이전</button>` : ""}${nums.map((n) => (n === "…" ? '<span class="form-hint">…</span>' : `<button class="btn sm pg-num ${n === page ? "primary" : ""}" data-p="${n}">${n}</button>`)).join("")}${page < pages ? `<button class="btn sm pg-num" data-p="${page + 1}">다음</button>` : ""}<span class="form-hint" style="margin-left:6px">총 ${total.toLocaleString("ko-KR")}명</span></div>`;
}

// 정렬 가능한 표
function sortableTable(el, cols, rows, { sort, desc = true, limit, rowClass, pageSize, rankCol } = {}) {
  let key = sort || cols.find((c) => c.sort)?.key;
  let dir = desc ? -1 : 1;
  let page = 1;
  function render() {
    const col = cols.find((c) => c.key === key);
    const sorted = [...rows].sort((a, b) => {
      const va = col?.val ? col.val(a) : a[key];
      const vb = col?.val ? col.val(b) : b[key];
      if (typeof va === "string") return dir * va.localeCompare(vb, "ko");
      return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
    });
    const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
    page = Math.min(page, pages);
    const off = pageSize ? (page - 1) * pageSize : 0;
    const shown = pageSize ? sorted.slice(off, off + pageSize) : limit ? sorted.slice(0, limit) : sorted;
    const cols2 = rankCol ? [{ key: "_n", label: "#", cls: "c num", sort: false, html: (r, i) => off + i + 1 }, ...cols] : cols;
    el.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr>${cols2
      .map((c) => `<th class="${c.cls || ""} ${c.sort !== false ? "sortable" : ""} ${c.key === key ? "sorted" : ""}" data-k="${c.key}">${c.label}</th>`)
      .join("")}</tr></thead><tbody>${shown
      .map((r, i) => `<tr class="${rowClass ? rowClass(r) : ""}">${cols2.map((c) => `<td class="${c.cls || ""}">${c.html ? c.html(r, i) : esc(r[c.key])}</td>`).join("")}</tr>`)
      .join("") || `<tr><td colspan="${cols2.length}">${emptyBox("데이터가 없습니다.")}</td></tr>`}</tbody></table></div>${pages > 1 ? pagerHtml(page, pages, sorted.length) : ""}`;
    $$(".pg-num", el).forEach((b) => b.addEventListener("click", () => { page = +b.dataset.p; render(); el.scrollIntoView({ block: "start", behavior: "smooth" }); }));
    $$("th.sortable", el).forEach((th) =>
      th.addEventListener("click", () => {
        if (key === th.dataset.k) dir *= -1;
        else { key = th.dataset.k; dir = -1; }
        page = 1;
        render();
      })
    );
  }
  render();
}

// 급상승 검색어 목록: 10개씩 번호 탭 + 검색
function trendPager(box, list, row, { per = 10 } = {}) {
  let page = 1, q = "";
  box.innerHTML = `<div class="tr-tools"><input class="input" placeholder="검색어 찾기" style="width:150px"><span class="form-hint"></span></div><div class="tr-body"></div><div class="tr-pager"></div>`;
  const body = $(".tr-body", box), pager = $(".tr-pager", box), hint = $(".tr-tools .form-hint", box);
  const draw = () => {
    const f = list.map((x, i) => [x, i]).filter(([x]) => !q || x.title.includes(q));
    const pages = Math.max(1, Math.ceil(f.length / per));
    page = Math.min(page, pages);
    hint.textContent = q ? `${f.length}개 찾음` : `전체 ${list.length}개`;
    body.innerHTML = f.length ? row(f.slice((page - 1) * per, page * per)) : emptyBox(q ? "찾는 검색어가 없습니다." : "수집된 급상승 검색어가 없습니다.");
    pager.innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<button class="pg-num ${i + 1 === page ? "on" : ""}" data-p="${i + 1}">${i * per + 1}~${Math.min((i + 1) * per, f.length)}</button>`).join("") : "";
    $$("button", pager).forEach((b) => b.addEventListener("click", () => { page = +b.dataset.p; draw(); }));
  };
  $("input", box).addEventListener("input", debounce((e) => { q = e.target.value.trim(); page = 1; draw(); }, 150));
  draw();
}

const nameList = (oids, max = 12) => esc(oids.slice(0, max).map(mediaName).join(" · ")) + (oids.length > max ? ` <span title="${esc(oids.slice(max).map(mediaName).join(", "))}">외 ${oids.length - max}곳</span>` : "");

function mediaListFor(A, kind) {
  const M = meta();
  const base = kind === "rank" ? M.ranking_media : M.publish_media;
  const src = kind === "rank" ? A.rank : A.pub;
  const all = [...new Set([...base, ...Object.keys(src)])].filter((o) => src[o] != null);
  return all;
}

function coverageNote(R) {
  const A = R.agg;
  const parts = [];
  parts.push(`랭킹 ${A.rankDayCount}/${R.n}일 · 발행 ${A.pubDayCount}/${R.n}일 수집됨`);
  if (A.partialDays.length) parts.push(`<span class="warn">${A.partialDays.map(mmdd).join(", ")} 랭킹은 집계 중(하루가 끝나지 않은 날)</span>`);
  return parts.join(" · ");
}

// ═══════════════════════════════════════════════════════
// 1. 뉴스통계 (N)
// ═══════════════════════════════════════════════════════
export async function dashboard(el, R, ctx) {
  const A = R.agg;
  const M = meta();
  const our = M.our_media;
  const P = (await R.previous()).agg;

  const SEL = mediaSel();
  const head = h(`<div class="page-head"><div><h1>뉴스통계 (N)</h1><p>네이버 언론사 랭킹과 매체별 발행량을 한눈에 봅니다. · ${coverageNote(R)}</p><p class="cov-line">${esc(naverCoverage().short)} ${info("coverage")}</p></div>
    <button class="btn" id="msBtn">⚙ 매체 설정 <span class="tag ${SEL.custom ? "orange" : "gray"}">랭킹 ${[...SEL.rank].filter((o) => (M.ranking_media || []).includes(o)).length} · 발행 ${[...SEL.pub].filter((o) => (M.publish_media || []).includes(o) || (M.count_media || []).includes(o)).length}${SEL.custom ? " · 내 설정" : ""}</span></button></div>`);
  const msSlot = h(`<div></div>`);
  el.append(head, msSlot);
  $("#msBtn", head).addEventListener("click", () => openMediaSettings(msSlot));

  // 공지
  const notices = activeNotices(ctx.board).slice(0, 4);

  if (!A.rankDayCount && !A.pubDayCount) {
    el.append(h(noData(R)));
    if (notices.length) el.append(noticeCard(notices, ctx));
    return;
  }

  const rankMedia = mediaListFor(A, "rank").sort((a, b) => (A.rank[b]?.views || 0) - (A.rank[a]?.views || 0));
  const ourRank = A.rank[our];
  const ourPos = rankMedia.indexOf(our) + 1;
  const pubMedia = mediaListFor(A, "pub").sort((a, b) => (A.pub[b] || 0) - (A.pub[a] || 0));
  const ourPubPos = pubMedia.indexOf(our) + 1;

  // 직전 동일 기간 (예: 9/24~9/30 → 9/17~9/23)
  const prevS = addDaysISO(R.s, -R.n), prevE = addDaysISO(R.s, -1);
  const prevLabel = `직전 동일 기간(${mmdd(prevS)}~${mmdd(prevE)}) 대비`;
  // 발행 카드: 기간 합계 + 일평균 + 직전 동일 기간 대비(같은 날 수가 수집됐으면 합계끼리, 아니면 하루 평균끼리)
  const pubCard = (oid) => {
    const cur = A.pub[oid], prev = P.pub[oid];
    const nd = A.pubDays?.[oid] || 0, pnd = P.pubDays?.[oid] || 0; // 이 매체가 실제로 수집된 날 수
    const fair = nd === pnd && nd === R.n;
    const d = cur == null ? "" : fair ? delta(cur, prev ?? null) : delta(cur / (nd || 1), prev != null && pnd ? prev / pnd : null);
    const partial = cur != null && nd < R.n;
    return `<div class="card kpi"><div class="label">${esc(mediaName(oid))} 발행 기사 ${info("ourPub")}</div>
      <div class="value ${oid === our ? "green" : "blue"} num">${cur != null ? fmt(cur) : "-"}<span title="${prevLabel}${fair ? "" : " · 수집된 날 수가 달라 하루 평균끼리 비교"}">${d}</span></div>
      <div class="meta">${cur != null ? `일평균 ${fmt1(cur / Math.max(1, nd))}건 · ${pubMedia.length}개 중 ${pubMedia.indexOf(oid) + 1}위 · ${R.n === 1 ? mmdd(R.s) : `${R.n}일`} 합계` : "발행 데이터 없음 (수집 중)"}</div>
      ${partial ? `<div class="meta warn">⚠ ${R.n}일 중 ${nd}일만 수집됨 — 나머지 날짜 수집 중이라 합계가 실제보다 적습니다 (일평균은 수집된 ${nd}일 기준)</div>` : ""}</div>`;
  };
  const cmp = M.compare_media || "296";
  el.append(h(`<div class="grid g-4">
    <div class="card kpi"><div class="label">랭킹 조회수 합 ${info("rankViews")}</div>
      <div class="value num">${short(A.rankViews)}<span title="${prevLabel}">${delta(A.rankViews / (A.rankDayCount || 1), P.rankDayCount ? P.rankViews / P.rankDayCount : null)}</span></div>
      <div class="meta">조회수 공개 ${rankMedia.length}개 매체 × 상위 ${M.ranking_size || 20}건 합계</div>
      <div class="meta" style="margin-top:4px;line-height:1.5">포함: ${nameList(rankMedia)}</div></div>
    <div class="card kpi"><div class="label">${esc(mediaName(our))} 랭킹 조회수 ${info("ourViews")}</div>
      <div class="value orange num">${ourRank ? short(ourRank.views) : "-"}<span title="${prevLabel}">${delta(ourRank ? ourRank.views / ourRank.days : null, P.rank[our] ? P.rank[our].views / P.rank[our].days : null)}</span></div>
      <div class="meta">${ourRank ? `점유율 ${pct(ourRank.views / A.rankViews)} · ${rankMedia.length}개 중 <b>${ourPos}위</b>` : "랭킹 데이터 없음"}</div></div>
    ${pubCard(our)}
    ${pubCard(cmp)}
  </div>`));
  el.append(h(`<div class="form-hint" style="margin-top:-8px">% = ${prevLabel}</div>`));

  // 일별 추이 + 매체 순위
  const row = h(`<div class="grid g-21">
    <div class="card" style="display:flex;flex-direction:column"><div class="card-head"><div><h3>일별 추이 ${info("trend")}</h3><div class="sub" id="trendSub"></div></div>
      <div class="tools"><select class="input" id="trendMedia"></select><div class="seg" id="trendSeg"><button data-m="both" class="on">발행 + 조회수</button><button data-m="pub">발행 기사수</button><button data-m="cmp">${esc(mediaName(our))}·${esc(mediaName(M.compare_media || "296"))} 비교</button><button data-m="views">랭킹 조회수</button></div></div></div>
      <div class="chart-box lg" style="flex:1;min-height:340px"><canvas></canvas></div>
      <div id="trendTbl"></div>
      <div class="form-hint" style="margin-top:6px">날짜 아래 요일 표시 · <b style="color:#dc2626">빨강</b> 일요일·공휴일(대체공휴일 포함, ‘휴’) · <b style="color:#2563eb">파랑</b> 토요일</div></div>
    <div class="card"><div class="card-head"><div><h3>매체별 랭킹 조회수 ${info("mediaRank")}</h3><div class="sub">상위 20건 조회수 합 · 증감은 직전 동일기간 대비 하루 평균 기준</div></div></div>
      <div id="mediaRank"></div></div>
  </div>`);
  el.append(row);

  const trendCanvas = $("canvas", row);
  let trendChart;
  // 겹쳐보기: 선택한 매체의 발행 기사수(막대) + 랭킹 조회수(선)
  const tMedia = [...new Set([...pubMedia, ...rankMedia])];
  const tSel = $("#trendMedia", row);
  tSel.innerHTML = tMedia.map((o) => `<option value="${o}" ${o === our ? "selected" : ""}>${esc(mediaName(o))}</option>`).join("");
  let tMode = "both";
  const drawTrend = () => {
    trendChart?.destroy();
    tSel.hidden = tMode !== "both";
    const sub = $("#trendSub", row);
    if (tMode === "both") {
      const oid = tSel.value;
      sub.textContent = `${mediaName(oid)} · 막대: 발행 기사수(왼쪽) · 선: 랭킹 조회수(오른쪽)${A.pubDay && !Object.values(A.pubDay).some((x) => x[oid] != null) ? " · 이 매체는 발행목록을 수집하지 않습니다" : ""}`;
      trendChart = comboChart(trendCanvas, dayLabels(R.days),
        { label: "발행 기사수", data: R.days.map((d) => A.pubDay[d]?.[oid] ?? null), backgroundColor: mediaColor(oid) + "99" },
        { label: "랭킹 조회수", data: R.days.map((d) => A.rankDay[d]?.[oid] ?? null), borderColor: "#0f2341", backgroundColor: "#0f2341", spanGaps: false }, { days: R.days });
      return;
    }
    $("#trendTbl", row).innerHTML = "";
    if (tMode === "cmp") {
      // 헬스조선 vs 코메디닷컴 발행 기사수 비교 (막대 + 날짜별 표)
      const two = [our, cmp];
      sub.textContent = `${mediaName(our)} vs ${mediaName(cmp)} · 날짜별 발행 기사수`;
      const val = (d, o) => A.pubDay[d]?.[o] ?? null;
      trendChart = barChart(trendCanvas, dayLabels(R.days), two.map((o) => ({ label: mediaName(o), data: R.days.map((d) => val(d, o)), backgroundColor: o === our ? OUR_COLOR : "#2563eb", maxBarThickness: 16 })), { days: R.days });
      const tot = two.map((o) => R.days.reduce((t, d) => t + (val(d, o) || 0), 0));
      const nd = two.map((o) => R.days.filter((d) => val(d, o) != null).length);
      const diff = (a, b) => (a == null || b == null ? "-" : `<span style="color:${a - b > 0 ? "#c2410c" : a - b < 0 ? "#2563eb" : "inherit"}">${a - b > 0 ? "+" : ""}${fmt(a - b)}</span>`);
      const dayCell = (d) => { const k = dayKind(d); return `<span style="color:${k ? DAY_COLOR[k] : "inherit"}" title="${esc(holiday(d))}">${mmdd(d)}(${weekday(d)}${holiday(d) ? "·휴" : ""})</span>`; };
      $("#trendTbl", row).innerHTML = `<div class="table-wrap trend-tbl"><table class="t"><thead><tr><th>날짜</th>${two.map((o) => `<th class="r">${esc(mediaName(o))}</th>`).join("")}<th class="r">차이</th></tr></thead><tbody>
        <tr class="ours"><td><b>합계</b> <span class="form-hint">${R.n}일</span></td>${tot.map((t, i) => `<td class="r num"><b>${nd[i] ? fmt(t) : "-"}</b></td>`).join("")}<td class="r num">${nd[0] && nd[0] === nd[1] ? diff(tot[0], tot[1]) : `<span class="form-hint" title="수집된 날 수가 달라 합계 차이는 표시하지 않음">${nd[0]}일·${nd[1]}일 수집</span>`}</td></tr>
        <tr><td>일평균</td>${tot.map((t, i) => `<td class="r num">${nd[i] ? fmt1(t / nd[i]) : "-"}</td>`).join("")}<td class="r num">${nd[0] && nd[1] ? fmt1(tot[0] / nd[0] - tot[1] / nd[1]) : "-"}</td></tr>
        ${[...R.days].reverse().map((d) => `<tr><td style="white-space:nowrap">${dayCell(d)}</td>${two.map((o) => `<td class="r num">${val(d, o) != null ? fmt(val(d, o)) : '<span class="form-hint">수집 전</span>'}</td>`).join("")}<td class="r num">${diff(val(d, our), val(d, cmp))}</td></tr>`).join("")}
        </tbody></table></div><div class="form-hint" style="margin-top:4px">차이 = ${esc(mediaName(our))} − ${esc(mediaName(cmp))}</div>`;
      return;
    }
    sub.textContent = R.n === 1 ? "하루만 선택됨 (기간을 넓히면 추이가 보입니다)" : "매체별 · 범례를 눌러 매체를 숨길 수 있습니다";
    const media = tMode === "views" ? rankMedia : pubMedia;
    const src = tMode === "views" ? A.rankDay : A.pubDay;
    const ds = media.map((oid) => ({
      label: mediaName(oid),
      data: R.days.map((d) => src[d]?.[oid] ?? null),
      color: mediaColor(oid),
      bold: isOur(oid),
      order: isOur(oid) ? 0 : 1,
    }));
    trendChart = R.n === 1
      ? barChart(trendCanvas, media.map(mediaName), [{ label: tMode === "views" ? "조회수" : "발행", data: media.map((o) => src[R.days[0]]?.[o] || 0), backgroundColor: media.map(mediaColor) }])
      : lineChart(trendCanvas, dayLabels(R.days), ds, { spanGaps: false, days: R.days });
  };
  drawTrend();
  tSel.addEventListener("change", drawTrend);
  $$("#trendSeg button", row).forEach((b) =>
    b.addEventListener("click", () => {
      $$("#trendSeg button", row).forEach((x) => x.classList.toggle("on", x === b));
      tMode = b.dataset.m;
      drawTrend();
    })
  );


  const maxV = Math.max(...rankMedia.map((o) => A.rank[o]?.views || 0), 1);
  $("#mediaRank", row).innerHTML = rankMedia.length
    ? `<table class="t"><tbody>${rankMedia
        .map(
          (oid, i) => `<tr class="${isOur(oid) ? "ours" : ""}"><td class="c" style="width:28px"><span class="rank-badge ${i < 3 ? "top" : ""}">${i + 1}</span></td>
      <td>${chip(oid)}</td><td style="width:34%"><div class="bar ${isOur(oid) ? "orange" : ""}"><span style="width:${((A.rank[oid].views / maxV) * 100).toFixed(1)}%"></span></div></td>
      <td class="r num">${short(A.rank[oid].views)}${delta(A.rank[oid].views / A.rank[oid].days, P.rank[oid] ? P.rank[oid].views / P.rank[oid].days : null)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : emptyBox("랭킹 데이터가 없습니다.");
  if (A.noView.size) $("#mediaRank", row).insertAdjacentHTML("beforeend", `<div class="form-hint" style="margin-top:10px">${[...A.noView].map((o) => esc(mediaName(o))).join(", ")}: 네이버 랭킹에 조회수를 공개하지 않아 순위·제목만 수집 (조회수 합계에서 제외)</div>`);

  // 키워드 + 급상승 + 공지
  const kws = keywordTable(A, P.rankDayCount || P.pubDayCount ? P : null);
  const topKw = [...kws].sort((a, b) => b.score - a.score).slice(0, 12);
  const rising = kws.filter((k) => k.score >= 4 && (k.isNew || (k.change != null && k.change > 0.2))).sort((a, b) => b.riseAmt - a.riseAmt).slice(0, 10);
  const riseSub = A.riseMode === "half" ? `기간 안에서 비교 ${mmdd(A.riseSplit[0])}~${mmdd(A.riseSplit[1])} → ${mmdd(A.riseSplit[2])}~${mmdd(A.riseSplit[3])} · ${A.riseParts} 하루 평균` : `직전 ${R.n}일 대비 · ${A.riseParts} 하루 평균`;
  const maxS = Math.max(...topKw.map((k) => k.score), 1);
  const kwRow = h(`<div class="grid g-3">
    <div class="card"><div class="card-head"><div><h3>많이 다룬 키워드 ${info("kwTitle")}</h3><div class="sub">제목 등장 빈도 (랭킹 진입은 3배 가중)</div></div><a href="${ctx.link("keywords")}">전체 보기</a></div>
      <div class="kw-list">${topKw.map((k, i) => `<a class="kw-row" href="${ctx.link("keywords", { k: k.word })}"><span class="n">${i + 1}</span><span class="w">${esc(k.word)}</span><div class="bar"><span style="width:${(k.score / maxS) * 100}%"></span></div><span class="v num">${fmt(k.pub)} / ${fmt(k.rank)}</span></a>`).join("") || emptyBox("키워드가 없습니다.")}</div>
      <div class="form-hint" style="margin-top:8px">숫자: 발행 기사수 / 랭킹 진입수</div></div>
    <div class="card"><div class="card-head"><div><h3>급상승 키워드 ${info("kwRising")}</h3><div class="sub">${riseSub}</div></div><a href="${ctx.link("keywords", { sort: "rise" })}">더 보기</a></div>
      <div class="kw-list">${rising.map((k, i) => `<a class="kw-row" href="${ctx.link("keywords", { k: k.word })}"><span class="n">${i + 1}</span><span class="w">${esc(k.word)}</span>${sparkline(R.days.map((d) => k.daily[d] || 0), { w: 120, color: "#dc2626" })}<span class="v">${k.isNew ? '<span class="tag new">NEW</span>' : `<span class="delta up">▲${Math.round(k.change * 100)}%</span>`}</span></a>`).join("") || emptyBox(A.riseMode ? "크게 늘어난 키워드가 없습니다." : "비교할 자료가 부족합니다 (수집된 날이 2일 이상 필요).")}</div></div>
    <div id="noticeSlot"></div>
  </div>`);
  el.append(kwRow);
  const ns = $("#noticeSlot", kwRow);
  ns.replaceWith(noticeCard(notices, ctx));

  // 랭킹 상위 기사
  const topRow = h(`<div class="grid g-21">
    <div class="card"><div class="card-head"><div><h3>랭킹 상위 기사 ${info("topArticles")}</h3><div class="sub">선택 기간 전체 매체 중 조회수 높은 순</div></div><a href="${ctx.link("articles")}">전체 보기</a></div><div id="topTable"></div></div>
    <div class="card"><div class="card-head"><div><h3>급상승 검색어 TOP 30 ${info("googleTrends")}</h3><div class="sub" id="trSub">구글 트렌드 한국</div></div><a href="${ctx.link("keywords", { tab: "search" })}">더 보기</a></div><div id="trList"><div class="loading"></div></div></div>
  </div>`);
  el.append(topRow);
  const topCard = topRow;
  R.search().then((S) => {
    const list = S.google.slice(0, 30);
    $("#trSub", topRow).textContent = S.days.length ? `구글 트렌드 한국 · ${S.fallback ? "가장 최근 수집 " : ""}${S.days.map(mmdd).join(", ").slice(0, 40)}${S.fallback ? " (선택 기간 밖)" : ""}` : "구글 트렌드 한국";
    const maxT = Math.max(...list.map((x) => x.traffic), 1);
    trendPager($("#trList", topRow), list, (rows) => `<div class="kw-list">${rows.map(([x, i]) => `<a class="kw-row" href="${ctx.link("keywords", { k: x.title })}" title="${esc(x.news[0]?.[0] || "")}"><span class="n">${i + 1}</span><span class="w">${esc(x.title)}</span><div class="bar orange"><span style="width:${(x.traffic / maxT) * 100}%"></span></div><span class="v num">${x.traffic ? fmt(x.traffic) + "+" : "-"}</span></a>`).join("")}</div>`);
  });
  articleTable($("#topTable", topCard), A.top.slice(0, 10), { showDay: R.n > 1 });

  // 수집 상태
  el.append(statusCard());
}

function noticeCard(notices, ctx) {
  return h(`<div class="card"><div class="card-head"><div><h3>공지사항 ${info("notice")}</h3><div class="sub">편집국 공지 · 안내</div></div><a href="#/board">게시판</a></div>
    <div class="notice-list">${notices.map((p) => `<a href="#/board/${encodeURIComponent(p.id)}">${p.pinned ? '<span class="tag orange">필독</span>' : `<span class="tag blue">${boardTypeLabel(p.type)}</span>`}<span class="t">${esc(p.title)}</span><span class="d">${dotDate(p.created).slice(5)}</span></a>`).join("") || emptyBox("등록된 공지가 없습니다.")}</div></div>`);
}

function statusCard() {
  const M = meta();
  const run = M.last_run;
  if (!run) return h(`<div class="card"><div class="status-line">아직 자동 수집 기록이 없습니다.</div></div>`);
  const errs = run.errors || [];
  return h(`<details class="card"><summary class="status-line" style="cursor:pointer">
      <b>수집 상태</b> ${info("status")} · 최근 수집 ${kstDateTime(run.at)} (${relTime(run.at)}) · ${run.range?.join(" ~ ") || ""} · ${run.ok ? '<span class="tag green">정상</span>' : `<span class="tag orange">경고 ${run.errors_n}건</span>`} · 소요 ${run.elapsed ?? "-"}초
    </summary>
    <div style="margin-top:10px">${errs.length ? `<div class="err-box">${errs.map(esc).join("<br>")}</div>` : '<div class="ok-box">모든 매체가 정상 수집되었습니다.</div>'}
    <div class="form-hint" style="margin-top:8px">조회수는 네이버 언론사별 랭킹(상위 ${M.ranking_size || 20}건)에 표시된 값입니다. 오늘 날짜의 랭킹은 하루가 끝날 때까지 계속 바뀌며, 자정 이후 수집분부터 확정값으로 봅니다.</div></div></details>`);
}

function articleTable(el, items, { showDay = true, showRank = true, showViews = true, showTime = false } = {}) {
  if (!items.length) {
    el.innerHTML = emptyBox("기사가 없습니다.");
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table class="t"><thead><tr>
    ${showDay ? "<th>날짜</th>" : ""}${showRank ? '<th class="c">순위</th>' : ""}<th>매체</th><th>제목</th><th>기자</th>${showTime ? "<th>발행</th>" : ""}${showViews ? '<th class="r">조회수</th>' : ""}
  </tr></thead><tbody>${items
    .map(
      (a) => `<tr class="${isOur(a.oid) ? "ours" : ""}">
      ${showDay ? `<td class="num" style="white-space:nowrap">${mmdd(a.day)}(${weekday(a.day)})</td>` : ""}
      ${showRank ? `<td class="c"><span class="rank-badge ${a.rank <= 3 ? "top" : ""}">${a.rank ?? "-"}</span></td>` : ""}
      <td>${chip(a.oid)}</td>
      <td class="title"><a href="${articleUrl(a.oid, a.aid)}" target="_blank" rel="noopener">${esc(a.title)}</a></td>
      <td style="white-space:nowrap">${esc(a.reporter || "")}</td>
      ${showTime ? `<td class="num" style="white-space:nowrap">${esc(a.time || (a.pub || "").slice(11, 16))}</td>` : ""}
      ${showViews ? `<td class="r num">${a.views == null ? '<span class="form-hint" title="네이버가 이 매체의 조회수를 공개하지 않습니다">미공개</span>' : fmt(a.views)}</td>` : ""}
    </tr>`
    )
    .join("")}</tbody></table></div>`;
}

// ═══════════════════════════════════════════════════════
// 2. 키워드 랭킹
// ═══════════════════════════════════════════════════════
export async function keywords(el, R, ctx) {
  const A = R.agg;
  const tab = ctx.q.tab === "search" ? "search" : "title";
  const head = h(`<div class="page-head"><div><h1>키워드 랭킹 ${info(tab === "search" ? "searchNaver" : "kwTitle")}</h1><p>${tab === "search" ? "독자가 실제로 검색한 키워드와 우리 기사 공급량을 비교합니다." : "기사 제목에서 뽑은 키워드의 발행량과 독자 반응(랭킹 조회수)을 비교합니다."} · ${coverageNote(R)}</p></div>
    <div class="seg" id="kwTab"><button data-t="title" class="${tab === "title" ? "on" : ""}">기사 제목 키워드</button><button data-t="search" class="${tab === "search" ? "on" : ""}">검색 키워드</button></div></div>`);
  el.append(head);
  $$("#kwTab button", head).forEach((b) => b.addEventListener("click", () => (location.hash = ctx.link("keywords", { tab: b.dataset.t === "search" ? "search" : "" }))));
  if (tab === "search") return searchKeywords(el, R, ctx);
  if (!A.kw.size) return el.append(h(noData(R)));
  const P = (await R.previous()).agg;
  const rows = keywordTable(A, P.rankDayCount || P.pubDayCount ? P : null);

  const state = { q: ctx.q.q || "", sort: ctx.q.sort || "score", k: ctx.q.k || "" };
  const card = h(`<div class="card">
    <div class="card-head"><div><h3>키워드 표 ${info("kwTitle")}</h3><div class="sub">행을 누르면 아래에 상세 분석이 열립니다</div></div>
      <div class="tools">
        <input class="input" id="kwq" placeholder="키워드 검색" value="${esc(state.q)}" style="width:160px">
        <div class="seg" id="kwSort">
          <button data-s="score">종합</button><button data-s="views">랭킹 조회수</button><button data-s="pub">발행량</button><button data-s="rise">급상승</button>
        </div>
      </div></div>
    <div class="form-hint" id="sortHint" style="margin:-6px 0 10px"></div>
    <div id="kwTable"></div></div>`);
  el.append(card);
  const detail = h(`<div id="kwDetail"></div>`);
  el.append(detail);

  const hints = {
    score: "종합 = 발행 기사수 + 랭킹 진입수 × 3",
    views: "해당 키워드가 들어간 랭킹 기사들의 조회수 합",
    pub: "선택한 발행목록 매체들이 해당 키워드로 쓴 기사 수",
    rise: A.riseMode === "half" ? `직전 기간 자료가 없어 선택 기간 앞쪽(${mmdd(A.riseSplit[0])}~${mmdd(A.riseSplit[1])}) 대비 뒤쪽(${mmdd(A.riseSplit[2])}~${mmdd(A.riseSplit[3])}) 하루 평균 증가 · NEW는 앞쪽에 없던 키워드` : `직전 동일기간(${R.n}일) 대비 종합점수 증가 · NEW는 직전 기간에 없던 키워드`,
    opp: "기회 = 랭킹 조회수 ÷ 발행 기사수. 적게 쓰였지만 많이 읽힌 주제 (발행 2건 이상, 랭킹 진입 1건 이상)",
  };
  const render = () => {
    $$("#kwSort button", card).forEach((b) => b.classList.toggle("on", b.dataset.s === state.sort));
    $("#sortHint", card).textContent = hints[state.sort];
    let list = rows.filter((r) => !state.q || r.word.toLowerCase().includes(state.q.toLowerCase()));
    if (state.sort === "rise") list = list.filter((r) => r.isNew || (r.change != null && r.change > 0)).sort((a, b) => b.riseAmt - a.riseAmt);
    else if (state.sort === "opp") list = list.filter((r) => r.pub >= 2 && r.rank >= 1).sort((a, b) => b.opportunity - a.opportunity);
    else if (state.sort === "views") list.sort((a, b) => b.views - a.views);
    else if (state.sort === "pub") list.sort((a, b) => b.pub - a.pub);
    else list.sort((a, b) => b.score - a.score);
    list = list.slice(0, 150);
    const showSpark = R.n > 1;
    $("#kwTable", card).innerHTML = `<div class="table-wrap" style="max-height:560px;overflow-y:auto"><table class="t"><thead><tr><th class="c">#</th><th>키워드</th>${showSpark ? "<th>추이</th>" : ""}<th class="r">발행</th><th class="r">랭킹 진입</th><th class="r">랭킹 조회수</th><th class="r" title="랭킹에 오른 기사 1건당 평균 조회수">랭킹 기사당 조회</th><th class="r">직전 대비</th></tr></thead><tbody>
      ${list
        .map(
          (r, i) => `<tr data-k="${esc(r.word)}" style="cursor:pointer" class="${r.word === state.k ? "ours" : ""}"><td class="c num">${i + 1}</td><td><b>${esc(r.word)}</b></td>
        ${showSpark ? `<td>${sparkline(R.days.map((d) => r.daily[d] || 0))}</td>` : ""}
        <td class="r num">${fmt(r.pub)}</td><td class="r num">${fmt(r.rank)}</td><td class="r num">${fmt(r.views)}</td><td class="r num">${r.rank ? fmt(r.perArticle) : "-"}</td>
        <td class="r">${r.isNew ? '<span class="tag new">NEW</span>' : r.change == null ? "-" : `<span class="delta ${r.change > 0 ? "up" : "down"}">${r.change > 0 ? "▲" : "▼"}${Math.abs(Math.round(r.change * 100))}%</span>`}</td></tr>`
        )
        .join("") || `<tr><td colspan="8">${emptyBox("조건에 맞는 키워드가 없습니다.")}</td></tr>`}
      </tbody></table></div>`;
    $$("tr[data-k]", card).forEach((tr) =>
      tr.addEventListener("click", () => {
        state.k = tr.dataset.k;
        ctx.setQuery({ k: state.k });
        render();
        showDetail(state.k);
      })
    );
  };
  $$("#kwSort button", card).forEach((b) => b.addEventListener("click", () => { state.sort = b.dataset.s; ctx.setQuery({ sort: state.sort }); render(); }));
  $("#kwq", card).addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); render(); }, 150));
  render();

  async function showDetail(word) {
    detail.innerHTML = '<div class="card"><div class="loading">키워드 분석 중…</div></div>';
    const row = rows.find((r) => r.word === word) || { word, pub: 0, rank: 0, views: 0, daily: {} };
    const [rk, ar, SR] = await Promise.all([R.ranking(), R.articles(), R.search()]);
    const sv = SR.volume[word] || SR.volume[Object.keys(SR.volume).find((w) => w.replace(/\s/g, "") === word.replace(/\s/g, "")) || ""];
    const has = (t) => t && t.toLowerCase().includes(word.toLowerCase());
    const rkHits = (rk || A.top).filter((a) => has(a.title));
    const arHits = ar ? ar.filter((a) => has(a.title)) : null;

    // 일별 발행/조회
    const dayPub = {}, dayViews = {};
    (arHits || []).forEach((a) => (dayPub[a.day] = (dayPub[a.day] || 0) + 1));
    rkHits.forEach((a) => (dayViews[a.day] = (dayViews[a.day] || 0) + (a.views || 0)));
    // 매체별
    const byMedia = {};
    (arHits || []).forEach((a) => ((byMedia[a.oid] ||= { pub: 0, rank: 0, views: 0 }).pub++));
    rkHits.forEach((a) => { const m = (byMedia[a.oid] ||= { pub: 0, rank: 0, views: 0 }); m.rank++; if (a.views != null) { m.views += a.views; m.hasV = true; } });
    // 연관 키워드 (같은 제목에 함께 등장)
    const vocab = [...A.kw.keys()].filter((w) => w !== word).sort((a, b) => kwScore(A.kw.get(b)) - kwScore(A.kw.get(a))).slice(0, 600);
    const co = new Map();
    for (const a of [...rkHits, ...(arHits || [])]) for (const w of vocab) if (a.title.includes(w)) co.set(w, (co.get(w) || 0) + (a.views ? 3 : 1));
    const related = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);

    detail.innerHTML = "";
    const arMedia = new Set((ar || []).map((a) => a.oid)); // 이 기간 발행목록(제목)을 수집한 매체
    const rkViews = rkHits.reduce((t, a) => t + (a.views || 0), 0);
    const pubN = arHits ? arHits.length : row.pub;
    const box = h(`<div class="card kw-detail">
      <div class="card-head"><div><h3>‘${esc(word)}’ 키워드 분석 ${info("kwDetail")}</h3><div class="sub">${esc(R.s.replace(/-/g, "."))}${R.n > 1 ? ` ~ ${esc(R.e.replace(/-/g, "."))}` : ""} · 기사 제목에 ‘${esc(word)}’가 들어간 기사 기준</div></div>
        <button class="btn sm" id="kwClose">닫기</button></div>
      <div class="kw-stats">
        <div><span>제목에 쓴 발행 기사</span><b>${fmt(pubN)}건</b><em>기자·제목까지 수집한 ${fmt(arMedia.size)}개 매체 기준</em></div>
        <div><span>랭킹 20위 안에 든 기사</span><b>${fmt(rkHits.length)}건</b><em>${fmt(new Set(rkHits.map((a) => a.oid)).size)}개 매체 랭킹</em></div>
        <div><span>그 기사들의 랭킹 조회수 합</span><b>${fmt(rkViews)}</b><em>조회수 미공개 매체 제외</em></div>
        ${sv ? `<div><span>네이버 월간 검색</span><b>${fmt(sv[0] + sv[1])}회</b><em>모바일 ${pct(sv[1] / Math.max(1, sv[0] + sv[1]), 0)}</em></div>` : SR.gvol[word] != null ? `<div><span>구글 관심도</span><b>${fmt1(SR.gvol[word])}</b><em>‘${esc(SR.gvolAnchor)}’ = 100</em></div>` : ""}
      </div>
      ${!ar ? `<div class="form-hint">발행 기사 목록은 ${LIMITS.articleDays}일 이하 기간에서 제공합니다.</div>` : ""}
      <div class="${R.n > 1 ? "grid g-21" : ""}">
        ${R.n > 1 ? `<div><h4 class="kw-h">날짜별 추이 <span class="form-hint">막대: 제목에 쓴 발행 기사 · 선: 랭킹 조회수</span></h4>${canvas()}</div>` : ""}
        <div><h4 class="kw-h">매체별</h4><div id="kwMedia"></div></div>
      </div>
      <h4 class="kw-h">랭킹에 오른 기사 <span class="form-hint">조회수 순 · 순위 = 그날 그 매체 랭킹 순위</span></h4><div id="kwTop"></div>
      ${arHits ? `<h4 class="kw-h">제목에 ‘${esc(word)}’가 들어간 발행 기사 <span class="form-hint">${fmt(arHits.length)}건${arHits.length > 20 ? " 중 최근 20건" : ""}</span></h4><div id="kwRecent"></div>` : ""}
      <h4 class="kw-h">함께 쓰인 키워드 <span class="form-hint">같은 제목에 함께 나온 단어 · 누르면 그 키워드 분석</span></h4>
      <div class="kw-cloud">${related.map(([w]) => `<a href="${ctx.link("keywords", { k: w })}">${esc(w)}</a>`).join("") || '<span class="form-hint">없음</span>'}</div>
    </div>`);
    detail.append(box);
    $("#kwClose", box).addEventListener("click", () => { detail.innerHTML = ""; state.k = ""; ctx.setQuery({ k: "" }); render(); });
    if (R.n > 1) {
      comboChart($("canvas", box), dayLabels(R.days),
        { label: "발행 기사수", data: R.days.map((d) => (arHits ? dayPub[d] || 0 : row.daily[d] || 0)), backgroundColor: "#bfd3fb" },
        { label: "랭킹 조회수", data: R.days.map((d) => dayViews[d] || 0), borderColor: OUR_COLOR, backgroundColor: OUR_COLOR }, { days: R.days });
    }
    const mm = Object.entries(byMedia).sort((a, b) => b[1].views - a[1].views || b[1].pub - a[1].pub);
    $("#kwMedia", box).innerHTML = mm.length
      ? `<table class="t"><thead><tr><th>매체</th><th class="r">제목에 쓴 발행 기사</th><th class="r">랭킹 20위 진입</th><th class="r">랭킹 조회수</th></tr></thead><tbody>${mm.map(([oid, m]) => `<tr class="${isOur(oid) ? "ours" : ""}"><td>${chip(oid)}</td><td class="r num">${arHits && arMedia.has(oid) ? fmt(m.pub) + "건" : '<span class="form-hint" title="이 매체는 아직 기사 제목 목록을 수집하지 않았습니다">미수집</span>'}</td><td class="r num">${fmt(m.rank)}건</td><td class="r num">${m.hasV ? fmt(m.views) : '<span class="form-hint">미공개</span>'}</td></tr>`).join("")}</tbody></table>`
      : emptyBox("데이터 없음");
    articleTable($("#kwTop", box), [...rkHits].sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, 15), { showDay: R.n > 1 });
    if (arHits) articleTable($("#kwRecent", box), [...arHits].sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time)).slice(0, 20), { showRank: false, showViews: false, showTime: true });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (state.k) showDetail(state.k);
}

// ═══════════════════════════════════════════════════════
// 3. 매체 비교
// ═══════════════════════════════════════════════════════
export async function media(el, R, ctx) {
  const A = R.agg;
  el.append(h(`<div class="page-head"><div><h1>매체 비교 ${info("mediaTable")}</h1><p>매체별 발행량과 랭킹 성과를 나란히 비교합니다. · ${coverageNote(R)}</p></div></div>`));
  if (!A.rankDayCount && !A.pubDayCount) return el.append(h(noData(R)));
  const P = (await R.previous()).agg;
  const all = [...new Set([...Object.keys(A.rank), ...Object.keys(A.pub)])];
  const rows = all.map((oid) => {
    const r = A.rank[oid];
    return {
      oid, name: mediaName(oid),
      pub: A.pub[oid] ?? null,
      pubDays: A.pubDays?.[oid] || 0,
      pubAvg: A.pub[oid] != null ? A.pub[oid] / Math.max(1, A.pubDays?.[oid] || 1) : null,
      views: r?.views ?? null,
      prevViews: P.rank[oid]?.views ?? null,
      dayAvg: r ? r.views / r.days : null,
      prevDayAvg: P.rank[oid] ? P.rank[oid].views / P.rank[oid].days : null,
      share: r ? r.views / A.rankViews : null,
      avg: r ? r.views / r.n : null,
      top1: r?.top1Days ? r.top1 / r.top1Days : null,
    };
  });
  const tcard = h(`<div class="card"><div class="card-head"><div><h3>매체별 성과표 ${info("mediaTable")}</h3><div class="sub">열 제목을 눌러 정렬 · 발행 기사 = 그 매체가 네이버에 송고한 전체 기사 수 (일평균은 수집된 날 기준)${A.noView.size ? ` · 조회수 미공개: ${[...A.noView].map((o) => esc(mediaName(o))).join(", ")}` : ""}</div></div></div><div id="mt"></div></div>`);
  el.append(tcard);
  const maxShare = Math.max(...rows.map((r) => r.share || 0), 0.0001);
  sortableTable($("#mt", tcard), [
    { key: "name", label: "매체", html: (r) => chip(r.oid) },
    { key: "pub", label: "발행 기사", cls: "r num", html: (r) => (r.pub == null ? '<span class="form-hint">수집 중</span>' : `${fmt(r.pub)}${r.pubDays < R.n ? `<div class="form-hint">${r.pubDays}/${R.n}일 수집</div>` : ""}`) },
    { key: "pubAvg", label: "일평균", cls: "r num", html: (r) => fmt1(r.pubAvg) },
    { key: "views", label: "랭킹 조회수", cls: "r num", html: (r) => `${fmt(r.views)}${delta(r.dayAvg, r.prevDayAvg)}` },
    { key: "share", label: "점유율", html: (r) => (r.share == null ? "-" : `<div style="display:flex;gap:8px;align-items:center"><div class="bar ${isOur(r.oid) ? "orange" : ""}" style="flex:1"><span style="width:${(r.share / maxShare) * 100}%"></span></div><span class="num" style="width:44px;text-align:right">${pct(r.share)}</span></div>`) },
    { key: "avg", label: "랭킹 기사 평균", cls: "r num", html: (r) => fmt(r.avg) },
    { key: "top1", label: "1위 평균", cls: "r num", html: (r) => fmt(r.top1) },
  ], rows, { sort: "views", rowClass: (r) => (isOur(r.oid) ? "ours" : "") });

  const rankMedia = mediaListFor(A, "rank");
  const pubMedia = mediaListFor(A, "pub");
  const charts = h(`<div class="grid g-2">
    <div class="card"><div class="card-head"><div><h3>랭킹 조회수 vs 발행량 ${info("mediaCombo")}</h3><div class="sub">막대: 랭킹 조회수 · 선: 발행 기사수 (둘 다 수집되는 매체)</div></div></div>${canvas("lg")}</div>
    <div class="card"><div class="card-head"><div><h3><span id="wdTitle">주간 랭킹 조회수 합</span> ${info("weekday")}</h3><div class="sub" id="wdSub"></div></div>
      <div class="seg" id="wdSeg"><button data-g="wk" class="on">주간 (월~일)</button><button data-g="mo">월간</button></div></div>
      <div class="wk-nav"><button class="btn sm" id="wkPrev" aria-label="이전">◀</button><input class="input" type="date" id="wkPick"><input class="input" type="month" id="moPick" hidden><button class="btn sm" id="wkNext" aria-label="다음">▶</button><b id="wkLabel"></b></div>${canvas("lg")}</div>
  </div>`);
  el.append(charts);
  const both = rows.filter((r) => r.views != null).sort((a, b) => b.views - a.views);
  const [c1, c2] = $$("canvas", charts);
  comboChart(c1, both.map((r) => r.name),
    { label: "랭킹 조회수", data: both.map((r) => r.views), backgroundColor: both.map((r) => mediaColor(r.oid)) },
    { label: "발행 기사수", data: both.map((r) => r.pub), borderColor: "#0f2341", backgroundColor: "#0f2341", spanGaps: true });

  // 주간(월~일 고정) / 월간 랭킹 조회수 합 — 상단 기간과 별도로 주·월을 골라 봄
  const yday = addDaysISO(kstTodayISO(), -1);
  const monOf = (d) => addDaysISO(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
  const longD = (d) => `${d.replace(/-/g, ".")}(${weekday(d)})`;
  let wkMode = "wk", wkStart = addDaysISO(monOf(yday), new Date(yday + "T00:00:00Z").getUTCDay() === 0 ? 0 : -7), moKey = yday.slice(0, 7);
  let wdChart;
  const drawWd = async () => {
    let s0, e0;
    if (wkMode === "wk") { s0 = wkStart; e0 = addDaysISO(wkStart, 6); }
    else { s0 = moKey + "-01"; const t = new Date(Date.UTC(+moKey.slice(0, 4), +moKey.slice(5, 7), 0)); e0 = t.toISOString().slice(0, 10); if (e0 > yday && s0 <= yday) e0 = yday; }
    $("#wkPick", charts).hidden = wkMode !== "wk"; $("#moPick", charts).hidden = wkMode !== "mo";
    $("#wkPick", charts).value = s0; $("#moPick", charts).value = moKey;
    $("#wkLabel", charts).textContent = `${longD(s0)} ~ ${longD(e0)}`;
    $("#wdTitle", charts).textContent = wkMode === "wk" ? "주간 랭킹 조회수 합" : "월간 랭킹 조회수 합";
    $("#wdSub", charts).textContent = wkMode === "wk" ? "매체별 · 하루 랭킹 조회수 합(상위 20건) · 월요일~일요일 7일 고정, 날짜를 고르면 그 주로 바뀝니다" : "매체별 · 그 달의 주(월~일)별 랭킹 조회수 합(상위 20건) · 달의 처음·끝 주는 그 달에 속한 날만";
    const RR = await new Range(s0, e0).init();
    const A2 = RR.agg;
    const media = mediaListFor(A2, "rank").sort((a, b) => (A2.rank[b]?.views || 0) - (A2.rank[a]?.views || 0));
    let labels, keys, days = null, key;
    if (wkMode === "wk") {
      keys = RR.days; days = RR.days; key = (d) => d;
      labels = RR.days.map((d) => [`${weekday(d)}${holiday(d) ? "·휴" : ""}`, mmdd(d) + (A2.rankDay[d] && Object.keys(A2.rankDay[d]).length ? "" : " 수집 전")]);
    } else {
      key = (d) => (monOf(d) < s0 ? s0 : monOf(d));
      keys = [...new Set(RR.days.map(key))];
      labels = keys.map((k) => { const end = addDaysISO(monOf(k), 6) > e0 ? e0 : addDaysISO(monOf(k), 6); const n = RR.days.filter((d) => key(d) === k && A2.rankDay[d] && Object.keys(A2.rankDay[d]).length).length; return [`${mmdd(k)}~${mmdd(end)}`, `${n}일 수집`]; });
    }
    const ds = media.map((oid) => {
      const sum = new Map();
      for (const d of RR.days) { const v = A2.rankDay[d]?.[oid]; if (v != null) sum.set(key(d), (sum.get(key(d)) || 0) + v); }
      return { label: mediaName(oid), data: keys.map((k) => sum.get(k) ?? null), backgroundColor: mediaColor(oid) };
    });
    wdChart?.destroy();
    wdChart = barChart(c2, labels, ds, { ...(days ? { days } : {}), plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded", font: { size: 11 } } }, tooltip: { backgroundColor: "#0f2341", callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.raw)}` } } } });
  };
  const shift = (dir) => {
    if (wkMode === "wk") wkStart = addDaysISO(wkStart, 7 * dir);
    else { const [y, m] = moKey.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + dir, 1)); moKey = t.toISOString().slice(0, 7); }
    drawWd();
  };
  $("#wkPrev", charts).addEventListener("click", () => shift(-1));
  $("#wkNext", charts).addEventListener("click", () => shift(1));
  $("#wkPick", charts).addEventListener("change", (e) => { if (e.target.value) { wkStart = monOf(e.target.value); drawWd(); } });
  $("#moPick", charts).addEventListener("change", (e) => { if (e.target.value) { moKey = e.target.value; drawWd(); } });
  $$("#wdSeg button", charts).forEach((b) => b.addEventListener("click", () => { $$("#wdSeg button", charts).forEach((x) => x.classList.toggle("on", x === b)); wkMode = b.dataset.g; drawWd(); }));
  drawWd();

  // 발행 시간대 히트맵
  if (pubMedia.length) {
    const hcard = h(`<div class="card"><div class="card-head"><div><h3>발행 시간대 히트맵 ${info("heatmap")}</h3><div class="sub">매체별 시간대(0~23시) 발행 기사 비중 · 칸에 마우스를 올리면 건수</div></div></div><div id="heat"></div></div>`);
    el.append(hcard);
    heatmap($("#heat", hcard), pubMedia.map((oid) => ({ label: mediaName(oid), oid, values: A.pubH[oid] || Array(24).fill(0) })));
  }
}

function heatmap(el, rows) {
  const cols = 24;
  let html = `<div class="heat" style="grid-template-columns: 90px repeat(${cols}, minmax(14px, 1fr))"><div></div>${Array.from({ length: cols }, (_, i) => `<div class="hh">${i}</div>`).join("")}`;
  for (const r of rows) {
    const max = Math.max(...r.values, 1);
    const color = mediaColor(r.oid);
    html += `<div class="hl">${esc(r.label)}</div>` + r.values.map((v, i) => `<div class="hc" title="${esc(r.label)} ${i}시: ${v}건" style="background:${color}${Math.round(Math.max(0.06, v / max) * 255).toString(16).padStart(2, "0")}">${v}</div>`).join("");
  }
  el.innerHTML = html + "</div>";
}

// ═══════════════════════════════════════════════════════
// 4. 기사 목록
// ═══════════════════════════════════════════════════════
export async function articles(el, R, ctx) {
  el.append(h(`<div class="page-head"><div><h1>기사 목록 ${info("articles")}</h1><p>랭킹 기사와 매체별 전체 발행 기사를 검색·정렬하고 엑셀로 내려받습니다.</p></div></div>`));
  const state = { src: ctx.q.src || "rank", media: ctx.q.m || "", q: ctx.q.q || "", sort: ctx.q.sort || "", page: 1 };
  const card = h(`<div class="card">
    <div class="card-head" style="flex-wrap:wrap">
      <div class="tools">
        <div class="seg" id="src"><button data-s="rank">랭킹 기사</button><button data-s="pub">전체 발행 기사</button></div>
        <select class="input" id="mSel"><option value="">전체 매체</option></select>
        <input class="input" id="q" placeholder="제목·기자 검색 (공백=AND)" style="width:220px" value="${esc(state.q)}">
        <select class="input" id="sort"></select>
      </div>
      <div class="tools"><span class="status-line" id="count"></span><button class="btn sm dl" id="xls">엑셀 저장</button></div>
    </div>
    <div id="list"><div class="loading">불러오는 중…</div></div></div>`);
  el.append(card);

  const SORTS = {
    rank: [["views", "조회수 높은 순"], ["date", "날짜·순위 순"], ["title", "제목 가나다"]],
    pub: [["date", "최신 발행 순"], ["old", "오래된 순"], ["title", "제목 가나다"]],
  };
  let data = [];
  let filtered = [];
  const PAGE = 50;

  async function load() {
    $$("#src button", card).forEach((b) => b.classList.toggle("on", b.dataset.s === state.src));
    const sortSel = $("#sort", card);
    sortSel.innerHTML = SORTS[state.src].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    if (!SORTS[state.src].some(([v]) => v === state.sort)) state.sort = SORTS[state.src][0][0];
    sortSel.value = state.sort;
    $("#list", card).innerHTML = '<div class="loading">불러오는 중…</div>';
    if (state.src === "rank") {
      data = (await R.ranking()) || null;
      if (!data) {
        data = R.agg.top;
        $("#count", card).textContent = "";
      }
    } else {
      data = await R.articles();
      if (!data) {
        $("#list", card).innerHTML = emptyBox(`전체 발행 기사 목록은 ${LIMITS.articleDays}일 이하 기간에서 볼 수 있습니다. 기간을 좁혀 조회해 주세요.`);
        $("#count", card).textContent = "";
        return;
      }
    }
    const medias = [...new Set(data.map((a) => a.oid))];
    const mSel = $("#mSel", card);
    mSel.innerHTML = `<option value="">전체 매체</option>` + medias.map((o) => `<option value="${o}">${esc(mediaName(o))}</option>`).join("");
    mSel.value = medias.includes(state.media) ? state.media : "";
    apply();
  }
  function apply() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = data.filter((a) => (!state.media || a.oid === state.media) && terms.every((t) => (a.title + " " + (a.reporter || "")).toLowerCase().includes(t)));
    const s = state.sort;
    filtered.sort((a, b) =>
      s === "views" ? (b.views ?? -1) - (a.views ?? -1)
        : s === "title" ? a.title.localeCompare(b.title, "ko")
        : s === "old" ? (a.day + (a.time || "")).localeCompare(b.day + (b.time || ""))
        : state.src === "rank" ? b.day.localeCompare(a.day) || a.oid.localeCompare(b.oid) || a.rank - b.rank
        : (b.day + (b.time || "")).localeCompare(a.day + (a.time || ""))
    );
    state.page = 1;
    draw();
  }
  function draw() {
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
    const items = filtered.slice((state.page - 1) * PAGE, state.page * PAGE);
    const rankNote = state.src === "rank" && !R.canRanking ? ` · ${LIMITS.rankingDays}일 초과 기간이라 일별 상위 30건만 표시` : "";
    $("#count", card).textContent = `${fmt(filtered.length)}건${rankNote}`;
    const box = $("#list", card);
    articleTable(box, items, { showDay: true, showRank: state.src === "rank", showViews: state.src === "rank", showTime: true });
    if (pages > 1) {
      box.append(h(`<div class="pager"><button class="btn sm" data-p="-1" ${state.page === 1 ? "disabled" : ""}>이전</button><span>${state.page} / ${pages}</span><button class="btn sm" data-p="1" ${state.page === pages ? "disabled" : ""}>다음</button></div>`));
      $$(".pager button", box).forEach((b) => b.addEventListener("click", () => { state.page += Number(b.dataset.p); draw(); card.scrollIntoView({ block: "start" }); }));
    }
  }
  $$("#src button", card).forEach((b) => b.addEventListener("click", () => { state.src = b.dataset.s; ctx.setQuery({ src: state.src }); load(); }));
  $("#mSel", card).addEventListener("change", (e) => { state.media = e.target.value; ctx.setQuery({ m: state.media }); apply(); });
  $("#sort", card).addEventListener("change", (e) => { state.sort = e.target.value; apply(); });
  $("#q", card).addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); apply(); }, 150));
  $("#xls", card).addEventListener("click", () =>
    ctx.exportSheets(`기사목록_${state.src === "rank" ? "랭킹" : "발행"}_${R.s}_${R.e}`, [{
      name: state.src === "rank" ? "랭킹기사" : "발행기사",
      rows: filtered.map((a) => ({
        날짜: a.day, 매체: mediaName(a.oid), ...(state.src === "rank" ? { 순위: a.rank, 조회수: a.views } : {}),
        제목: a.title, 기자: a.reporter || "", 발행시각: a.time || (a.pub || "").slice(11, 16), 링크: articleUrl(a.oid, a.aid),
      })),
    }])
  );
  load();
}

// ═══════════════════════════════════════════════════════
// 5. 작성 인사이트 (시간대·요일·제목 패턴)
// ═══════════════════════════════════════════════════════
const PATTERNS = [
  ["숫자 포함", /\d/],
  ["N가지·N개", /\d+\s*(가지|개|곳|명|종)/],
  ["물음표(질문형)", /\?|？/],
  ["따옴표 인용", /["“”'‘’]/],
  ["말줄임(…)", /…|\.\.\./],
  ["[대괄호] 머리표", /^\s*[\[【]/],
  ["호기심어(이것·이유·비결…)", /이것|이유|비결|정체|방법|진짜|충격|알고 보니|뜻밖/],
  ["느낌표", /!|！/],
];

export async function insights(el, R, ctx) {
  const A = R.agg;
  const M = meta();
  el.append(h(`<div class="page-head"><div><h1>작성 인사이트 ${info("insightSummary")}</h1><p>언제, 어떤 제목으로 쓴 기사가 더 많이 읽혔는지 데이터로 확인합니다. · ${coverageNote(R)}</p></div></div>`));
  if (!A.rankDayCount && !A.pubDayCount) return el.append(h(noData(R)));
  const [rk, ar] = await Promise.all([R.ranking(), R.articles()]);

  // 시간대
  const pubHourAll = Array(24).fill(0);
  Object.values(A.pubH).forEach((arr) => arr.forEach((v, i) => (pubHourAll[i] += v)));
  const avgByHour = A.rankH[0].map((n, i) => (n >= 2 ? A.rankH[1][i] / n : null));
  const bestHours = avgByHour.map((v, i) => [i, v]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const busiest = pubHourAll.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  // 요일
  const wdAvg = WD_ORDER.map((w) => (A.wd.rankDays[w] ? A.wd.views[w] / A.wd.rankDays[w] : null));
  const wdPubAvg = WD_ORDER.map((w) => (A.wd.pubDays[w] ? A.wd.pub[w] / A.wd.pubDays[w] : null));
  const bestWd = WD_ORDER.map((w, i) => [w, wdAvg[i]]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];

  // 제목 패턴
  const rkTitles = (rk || A.top).filter((a) => a.views != null); // 조회수 미공개 매체 제외
  const meanViews = rkTitles.length ? rkTitles.reduce((s, a) => s + a.views, 0) / rkTitles.length : 0;
  const pat = PATTERNS.map(([name, re]) => {
    const w = rkTitles.filter((a) => re.test(a.title));
    const wo = rkTitles.filter((a) => !re.test(a.title));
    const avgW = w.length ? w.reduce((s, a) => s + a.views, 0) / w.length : null;
    const avgWo = wo.length ? wo.reduce((s, a) => s + a.views, 0) / wo.length : null;
    const base = ar ? ar.filter((a) => re.test(a.title)).length / ar.length : null;
    return { name, n: w.length, share: rkTitles.length ? w.length / rkTitles.length : 0, base, lift: avgW && avgWo ? avgW / avgWo - 1 : null };
  });
  // 제목 길이
  const buckets = [[0, 20], [20, 30], [30, 40], [40, 50], [50, 999]];
  const lenStats = buckets.map(([a, b]) => {
    const items = rkTitles.filter((x) => x.title.length >= a && x.title.length < b);
    return { label: b === 999 ? `${a}자 이상` : `${a}~${b - 1}자`, n: items.length, avg: items.length ? items.reduce((s, x) => s + x.views, 0) / items.length : 0 };
  });
  const bestLen = [...lenStats].filter((x) => x.n >= 5).sort((a, b) => b.avg - a.avg)[0];
  const avgLenRank = rkTitles.length ? rkTitles.reduce((s, a) => s + a.title.length, 0) / rkTitles.length : 0;
  const avgLenAll = ar?.length ? ar.reduce((s, a) => s + a.title.length, 0) / ar.length : null;

  // 우리 매체 발행 시간 vs 잘 읽힌 시간
  const ourH = A.pubH[M.our_media];
  const ourPeak = ourH ? ourH.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => i) : [];

  const tips = [];
  if (bestHours.length) tips.push(["⏰", `랭킹 기사의 평균 조회수는 <b>${bestHours.map(([i]) => `${i}시`).join(", ")}</b> 발행 기사에서 가장 높았습니다 (각 ${bestHours.map(([, v]) => short(v)).join(" / ")}).`]);
  if (busiest.length && busiest[0][1]) tips.push(["📰", `전체 매체의 발행이 몰리는 시간은 <b>${busiest.map(([i]) => `${i}시`).join(", ")}</b>입니다. 이 시간대는 경쟁이 치열합니다.`]);
  if (ourPeak.length && ourH.some((v) => v)) tips.push(["🏠", `${esc(mediaName(M.our_media))}은(는) 주로 <b>${ourPeak.map((i) => `${i}시`).join(", ")}</b>에 발행했습니다.${bestHours.length && !ourPeak.includes(bestHours[0][0]) ? ` 조회수가 높은 ${bestHours[0][0]}시대 발행을 늘려보는 것도 방법입니다.` : ""}`]);
  if (bestWd) tips.push(["📅", `요일별로는 <b>${WD_NAME[bestWd[0]]}요일</b>의 하루 랭킹 조회수 합(평균)이 가장 높았습니다.`]);
  const strong = pat.filter((p) => p.lift != null && p.n >= 5).sort((a, b) => b.lift - a.lift);
  if (strong[0] && strong[0].lift > 0.05) tips.push(["✍️", `‘${strong[0].name}’ 제목의 랭킹 기사는 그렇지 않은 기사보다 평균 조회수가 <b>${pct(strong[0].lift, 0)}</b> 높았습니다.`]);
  const weak = strong[strong.length - 1];
  if (weak && weak.lift < -0.05) tips.push(["⚠️", `‘${weak.name}’ 제목은 평균 조회수가 ${pct(-weak.lift, 0)} 낮았습니다.`]);
  if (bestLen) tips.push(["📏", `제목 길이는 <b>${bestLen.label}</b>일 때 평균 조회수가 가장 높았습니다. (랭킹 기사 평균 ${fmt1(avgLenRank)}자${avgLenAll ? `, 전체 발행 평균 ${fmt1(avgLenAll)}자` : ""})`]);

  el.append(h(`<div class="card"><div class="card-head"><div><h3>이번 기간 요약 ${info("insightSummary")}</h3><div class="sub">상관관계이며 인과관계는 아닙니다. 표본이 적은 기간은 참고만 하세요.</div></div></div>
    <ul class="insight-list">${tips.map(([i, t]) => `<li><span class="ico">${i}</span><span>${t}</span></li>`).join("") || `<li>${emptyBox("분석할 데이터가 부족합니다.")}</li>`}</ul></div>`));

  const charts = h(`<div class="grid g-2">
    <div class="card"><div class="card-head"><div><h3>발행 시간대별 반응 ${info("insightHour")}</h3><div class="sub">막대: 전체 매체 발행 기사수 · 선: 그 시간에 발행된 랭킹 기사의 평균 조회수${avgByHour.every((v) => v == null) ? '<br><span style="color:#b45309">랭킹 기사의 입력시각이 아직 없어 선은 표시되지 않습니다 (엑셀에서 가져온 자료는 ‘기자명 채우기’를 하면 입력시각도 함께 채워집니다)</span>' : ""}</div></div></div>${canvas("lg")}</div>
    <div class="card"><div class="card-head"><div><h3>요일별 반응 ${info("insightWeekday")}</h3><div class="sub">막대: 하루 평균 발행 기사수 · 선: 하루 랭킹 조회수 합의 요일 평균</div></div></div>${canvas("lg")}</div>
  </div>`);
  el.append(charts);
  const [c1, c2] = $$("canvas", charts);
  comboChart(c1, Array.from({ length: 24 }, (_, i) => `${i}시`), { label: "발행 기사수", data: pubHourAll, backgroundColor: "#bfd3fb" }, { label: "랭킹 평균 조회수", data: avgByHour, borderColor: OUR_COLOR, backgroundColor: OUR_COLOR, spanGaps: true });
  comboChart(c2, WD_ORDER.map((w) => WD_NAME[w]), { label: "하루 평균 발행", data: wdPubAvg, backgroundColor: "#bfd3fb" }, { label: "하루 랭킹 조회수 합(평균)", data: wdAvg, borderColor: OUR_COLOR, backgroundColor: OUR_COLOR, spanGaps: true });

  const maxShare = Math.max(...pat.map((p) => Math.max(p.share, p.base || 0)), 0.01);
  // 독자가 읽은 시간대 (매시간 조회수 증가량)
  const readMedia = Object.keys(A.readH);
  const readTotal = Array(24).fill(0);
  readMedia.forEach((o) => A.readH[o].forEach((v, i) => (readTotal[i] += v)));
  const readCard = h(`<div class="card"><div class="card-head"><div><h3>독자가 많이 읽은 시간대 ${info("readHour")}</h3><div class="sub">${A.readDays ? `랭킹 상위 기사 조회수가 시간마다 얼마나 늘었는지 (${A.readDays}일 하루 평균) · 막대: 수집 매체 전체 · 선: ${esc(mediaName(M.our_media))}` : "매시간 수집 기록이 쌓이면 표시됩니다"}</div></div></div>
    ${A.readDays ? canvas("lg") : emptyBox("아직 시간대별 기록이 없습니다.<br>네이버 랭킹은 하루 누적 조회수만 보여주기 때문에, 매시간 조회수를 기록해 그 차이로 계산합니다.<br>GitHub 자동 수집(매시간)을 켜면 하루 뒤부터 이 그래프가 채워집니다. 과거 엑셀 자료로는 계산할 수 없습니다.")}</div>`);
  el.append(readCard);
  if (A.readDays) {
    const ourR = (A.readH[M.our_media] || Array(24).fill(0)).map((v) => v / A.readDays);
    comboChart($("canvas", readCard), Array.from({ length: 24 }, (_, i) => `${i}시`),
      { label: "전체 매체 시간당 조회수", data: readTotal.map((v) => v / A.readDays), backgroundColor: "#bfd3fb" },
      { label: `${mediaName(M.our_media)} 시간당 조회수`, data: ourR, borderColor: OUR_COLOR, backgroundColor: OUR_COLOR });
    const peak = readTotal.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => `${i}시`);
    const ourPeak = ourR.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => `${i}시`);
    $(".insight-list", el)?.insertAdjacentHTML("afterbegin", `<li><span class="ico">👀</span><span>독자가 가장 많이 읽은 시간대는 <b>${peak.join(", ")}</b>입니다${A.pubH[M.our_media] || A.readH[M.our_media] ? ` (${esc(mediaName(M.our_media))}: ${ourPeak.join(", ")})` : ""}. 발행 시간대와 비교해 출고 시점을 정해보세요.</span></li>`);
  }

  const pcard = h(`<div class="grid g-21">
    <div class="card"><div class="card-head"><div><h3>제목 패턴별 성과 ${info("titlePattern")}</h3><div class="sub">랭킹 기사 ${fmt(rkTitles.length)}건 기준${rk ? "" : " (긴 기간이라 일별 상위 30건)"} · 조회수 차이 = 패턴 있는 기사 평균 ÷ 없는 기사 평균</div></div></div>
      <div class="pattern-row" style="font-size:12px;color:var(--muted);font-weight:600"><span>패턴</span><span>랭킹 기사 중 비율${ar ? " (회색: 전체 발행 중 비율)" : ""}</span><span style="text-align:right">조회수 차이</span><span style="text-align:right">해당 기사</span></div>
      ${pat.map((p) => `<div class="pattern-row"><span>${p.name}</span>
        <div><div class="bar" title="랭킹 ${pct(p.share)}"><span style="width:${(p.share / maxShare) * 100}%"></span></div>${p.base != null ? `<div class="bar" style="margin-top:3px;height:5px" title="전체 ${pct(p.base)}"><span style="width:${(p.base / maxShare) * 100}%;background:#94a3b8"></span></div>` : ""}</div>
        <span style="text-align:right">${p.lift == null || p.n < 3 ? "-" : `<span class="delta ${p.lift > 0 ? "up" : "down"}">${p.lift > 0 ? "+" : ""}${Math.round(p.lift * 100)}%</span>`}</span>
        <span style="text-align:right" class="num">${fmt(p.n)}건 · ${pct(p.share, 0)}</span></div>`).join("")}
    </div>
    <div class="card"><div class="card-head"><div><h3>제목 길이별 평균 조회수 ${info("titleLength")}</h3><div class="sub">랭킹 기사 · 공백 포함 글자수</div></div></div>${canvas()}
      <div class="form-hint" style="margin-top:8px">랭킹 기사 전체 평균 조회수 ${fmt(meanViews)}</div></div>
  </div>`);
  el.append(pcard);
  barChart($("canvas", pcard), lenStats.map((x) => `${x.label} (${x.n})`), [{ label: "평균 조회수", data: lenStats.map((x) => x.avg), backgroundColor: lenStats.map((x) => (x === bestLen ? OUR_COLOR : "#93b4f5")) }]);
}

// ═══════════════════════════════════════════════════════
// 6. 기자 통계 — 기사 원본(랭킹·발행)에서 직접 계산
// ═══════════════════════════════════════════════════════
export async function reporters(el, R, ctx) {
  const A = R.agg;
  const M = meta();
  const SEL = mediaSel();
  const head = h(`<div class="page-head"><div><h1>기자 통계 ${info("reporters")}</h1><p>네이버 기사 페이지의 바이라인에서 확인한 기자별 발행량과 랭킹 성과입니다. 기자를 누르면 기사 목록이 열립니다.</p>
    <div class="rep-media" id="repMedia"><span class="form-hint">적용 매체 확인 중…</span></div></div>
    <button class="btn" id="msBtn">⚙ 매체 추가·삭제</button></div>`);
  const msSlot = h(`<div></div>`);
  el.append(head, msSlot);
  $("#msBtn", head).addEventListener("click", () => openMediaSettings(msSlot));
  if (!A.rankDayCount && !A.pubDayCount) return el.append(h(noData(R)));
  const loading = h('<div class="card"><div class="loading">기자별 기사를 모으는 중…</div></div>');
  el.append(loading);
  const [rk, ar] = await Promise.all([R.ranking(), R.articles()]);
  // 기간 마지막 날 발행 기사가 다음 날 랭킹에 오르는 경우까지 보려고, 기간 뒤 2일 랭킹을 진입률 계산에만 추가로 읽음
  const yd = addDaysISO(kstTodayISO(), -1);
  const extraDays = [1, 2].map((n) => addDaysISO(R.e, n)).filter((d) => d <= yd && (M.ranking_days || []).includes(d));
  const rkAfter = rk && extraDays.length ? await loadRankingDays(extraDays) : [];
  loading.remove();
  // 적용 매체: 매체 설정에서 고른 매체 중 기자명을 확인하는 매체 (설정을 바꾸면 자동 반영)
  {
    const cov = (items) => { const c = {}; for (const a of items || []) { const x = (c[a.oid] ||= [0, 0]); x[0]++; if (a.reporter) x[1]++; } return c; };
    const rc = cov(rk), pc = cov(ar);
    const rankOn = [...SEL.rank].filter((o) => (M.ranking_media || []).includes(o)).sort((a, b) => (rc[b]?.[0] || 0) - (rc[a]?.[0] || 0));
    const pubOn = [...SEL.pub].filter((o) => (M.publish_media || []).includes(o)).sort((a, b) => (pc[b]?.[0] || 0) - (pc[a]?.[0] || 0));
    const cntOnly = [...SEL.pub].filter((o) => !(M.publish_media || []).includes(o) && (M.count_media || []).includes(o));
    const chip = (o, c) => `<span class="rep-chip${isOur(o) ? " ours" : ""}" title="${c ? `기사 ${fmt(c[0])}건 중 기자명 확인 ${fmt(c[1])}건` : "이 기간 데이터 없음"}">${esc(mediaName(o))}${c ? ` <b>${Math.round((c[1] / c[0]) * 100)}%</b>` : ""}</span>`;
    $("#repMedia", head).innerHTML = `<div><span class="rep-lab">랭킹 기사 (기자·조회수) ${rankOn.length}곳</span>${rankOn.map((o) => chip(o, rc[o])).join("")}</div>
      <div><span class="rep-lab">전체 발행 기사 (기자) ${pubOn.length}곳</span>${pubOn.map((o) => chip(o, pc[o])).join("") || '<span class="form-hint">없음</span>'}</div>
      ${cntOnly.length ? `<div class="form-hint">발행 건수만 집계하는 ${cntOnly.length}곳(${esc(cntOnly.slice(0, 6).map(mediaName).join(", "))}${cntOnly.length > 6 ? " 등" : ""})은 기자명을 확인하지 않아 랭킹 기사로만 반영됩니다.</div>` : ""}
      <div class="form-hint">% = 기자명 확인 비율 · ‘매체 추가·삭제’나 뉴스통계 (N)의 매체 설정을 바꾸면 이 목록과 기자 통계가 자동으로 바뀝니다.${SEL.custom ? " (지금 내 설정 사용 중)" : ""}</div>`;
  }

  const map = new Map();
  const get = (name, oid) => {
    const key = name + "|" + oid;
    if (!map.has(key)) map.set(key, { name, oid, mname: mediaName(oid), pub: 0, rank: 0, rankDays: 0, top1: 0, top3: 0, views: 0, viewN: 0, best: null, rkItems: [], pubItems: [], pubSet: new Set(), rankSet: new Set(), enterSet: new Set() });
    return map.get(key);
  };
  // 매체 이름이 기자명 자리에 들어간 예전 수집분은 제외 (예: "서울신문", "헬스조선")
  const mediaNames = new Set(Object.values(M.media || {}));
  const isPerson = (n) => /^[가-힣]{2,4}$/.test(n) && !mediaNames.has(n) && !/(일보|신문|뉴스|닷컴|조선|방송|미디어|경제|이미지|사진|영상)/.test(n);
  const split = (s) => (s || "").split("·").map((x) => x.trim()).filter(isPerson);
  let rkTotal = 0, rkNamed = 0, arTotal = 0, arNamed = 0;
  if (rk) {
    for (const a of rk) {
      rkTotal++;
      const names = split(a.reporter);
      if (names.length) rkNamed++;
      for (const n of names) {
        const r = get(n, a.oid);
        r.rankDays++; r.rankSet.add(a.oid + "_" + a.aid); if (a.rank === 1) r.top1++; if (a.rank <= 3) r.top3++;
        if (a.views != null) { r.views += a.views; r.viewN++; if (!r.best || a.views > r.best.views) r.best = a; }
        r.rkItems.push(a);
      }
    }
  }
  if (ar) {
    for (const a of ar) {
      arTotal++;
      const names = split(a.reporter);
      if (names.length) arNamed++;
      for (const n of names) { const r = get(n, a.oid); r.pubSet.add(a.oid + "_" + a.aid); r.pubItems.push(a); } // 공동 기자는 각자 발행 수에 포함
    }
    // 랭킹에 오른 기사 중 기간 안에 발행됐는데 발행 목록에서 빠진 기사(공동 바이라인 표기 차이 등)도 발행 수에 더함
    const detail = new Set(ar.map((a) => a.oid)); // 이 기간 발행목록이 실제로 수집된 매체만
    const arDay = new Set(ar.map((a) => a.oid + "|" + a.day)); // 기자명까지 확인한 발행목록이 있는 매체·날짜
    for (const r of map.values()) {
      if (!detail.has(r.oid)) continue;
      for (const a of r.rkItems) { const pd = (a.pub || a.day || "").slice(0, 10); if (pd >= R.s && pd <= R.e && arDay.has(a.oid + "|" + pd)) r.pubSet.add(a.oid + "_" + a.aid); } // 그날 발행목록이 수집된 경우만
    }
    for (const r of map.values()) r.pub = r.pubSet.size;
    // 기간 발행 기사 중 20위 안에 든 기사 (기간 안 랭킹 + 기간 뒤 2일 랭킹)
    const ranked = new Set([...(rk || []), ...rkAfter].map((a) => a.oid + "_" + a.aid));
    for (const r of map.values()) for (const k of r.pubSet) if (ranked.has(k)) r.enterSet.add(k);
  } else {
    // 31일 넘는 기간: 발행 수는 일별 요약값 사용
    for (const x of A.rep.values()) for (const n of split(x.name)) get(n, x.oid).pub += x.pub;
  }
  for (const r of map.values()) r.rank = r.rankSet.size; // 랭킹 진입 = 랭킹에 오른 서로 다른 기사 수 (같은 기사가 며칠 올라도 1건)
  if (!rk) for (const x of A.rep.values()) for (const n of split(x.name)) { const r = get(n, x.oid); r.rank += x.rank; r.views += x.views; r.viewN += x.rank; }
  const rows = [...map.values()].map((r) => ({ ...r, bestViews: r.best ? r.best.views : null, avg: r.viewN ? r.views / r.viewN : null, enter: ar ? r.enterSet.size : null, rate: ar && r.pub ? r.enterSet.size / r.pub : null, pubDay: r.pub / Math.max(1, A.pubDayCount) }));

  if (!rows.length) {
    el.append(h(`<div class="card">${emptyBox("이 기간 기사에는 아직 기자명이 없습니다.<br>엑셀에서 가져온 과거 자료는 기자명이 비어 있어요. 자동 수집으로 새로 받은 기사부터 기자명이 들어갑니다.")}</div>`));
    return;
  }
  const byViews = [...rows].sort((a, b) => b.views - a.views)[0];
  const byPub = [...rows].sort((a, b) => b.pub - a.pub)[0];
  const ourRows = rows.filter((r) => r.oid === M.our_media);
  const ourByViews = [...ourRows].filter((r) => r.views > 0).sort((a, b) => b.views - a.views)[0];
  const ourByPub = [...ourRows].filter((r) => r.pub > 0).sort((a, b) => b.pub - a.pub)[0];
  const ourN = mediaName(M.our_media);
  el.append(h(`<div class="rep-kpis"><div class="grid g-4">
    <div class="card kpi"><div class="label">확인된 기자</div><div class="value blue num">${fmt(rows.length)}명</div>
      <div class="meta">${esc(mediaName(M.our_media))} ${fmt(ourRows.length)}명 · ${fmt(new Set(rows.map((r) => r.oid)).size)}개 매체</div></div>
    <div class="card kpi"><div class="label">기자명 확인 비율 ${info("reporterCoverage")}</div><div class="value num">${rkTotal ? pct(rkNamed / rkTotal, 0) : "-"}</div>
      <div class="meta">랭킹 기사 ${fmt(rkNamed)}/${fmt(rkTotal)}${arTotal ? ` · 발행 기사 ${pct(arNamed / arTotal, 0)}` : ""}</div></div>
    <div class="card kpi"><div class="label">전체 랭킹 조회수 1위 기자</div><div class="value orange" style="font-size:22px">${esc(byViews.name)}</div>
      <div class="meta">${esc(byViews.mname)} · ${short(byViews.views)} · 랭킹 ${fmt(byViews.rank)}건</div></div>
    <div class="card kpi"><div class="label">전체 발행 1위 기자</div><div class="value green" style="font-size:22px">${esc(byPub.name)}</div>
      <div class="meta">${esc(byPub.mname)} · ${fmt(byPub.pub)}건 · 하루 ${fmt1(byPub.pubDay)}건</div></div>
  </div>
  <div class="grid g-2">
    <div class="card kpi ours-kpi"><div class="label">${esc(ourN)} 랭킹 조회수 1위 기자</div>${ourByViews ? `<div class="value orange" style="font-size:22px">${esc(ourByViews.name)}</div>
      <div class="meta">${short(ourByViews.views)} · 랭킹 ${fmt(ourByViews.rank)}건${ourByViews.top1 ? ` · 1위 ${fmt(ourByViews.top1)}회` : ""}${ourByViews.best ? ` · 최고 ${fmt(ourByViews.best.views)}` : ""}</div>` : '<div class="meta">이 기간 데이터 없음</div>'}</div>
    <div class="card kpi ours-kpi"><div class="label">${esc(ourN)} 발행 1위 기자</div>${ourByPub ? `<div class="value green" style="font-size:22px">${esc(ourByPub.name)}</div>
      <div class="meta">${fmt(ourByPub.pub)}건 · 하루 ${fmt1(ourByPub.pubDay)}건 · 랭킹 진입 ${fmt(ourByPub.rank)}건</div>` : '<div class="meta">이 기간 데이터 없음</div>'}</div>
  </div></div>`));

  const medias = [...new Set(rows.map((r) => r.oid))].sort((a, b) => (a === M.our_media ? -1 : b === M.our_media ? 1 : mediaName(a).localeCompare(mediaName(b), "ko")));
  const card = h(`<div class="card"><div class="card-head"><div><h3>기자별 성과 ${info("reporters")}</h3><div class="sub">진입률 = 기간 중 발행한 기사 가운데 매체 랭킹 20위 안에 든 기사 수 ÷ 기간 발행 기사 수 (최고 100%, 발행 다음 2일 랭킹까지 확인, 발행목록을 수집하는 매체만) · 공동 기자 기사는 각 기자의 발행·랭킹에 모두 포함 · 취합 조회수 합계 = 랭킹(매체별 상위 20건)에 오른 기사 조회수의 합</div></div>
    <div class="tools"><select class="input" id="rm"><option value="">전체 매체</option>${medias.map((o) => `<option value="${o}">${esc(mediaName(o))}</option>`).join("")}</select>
    <input class="input" id="rq" placeholder="기자명 검색" style="width:130px"><div class="seg" id="rsize"><button data-n="30" class="on">30명씩</button><button data-n="100">100명씩</button></div><button class="btn sm dl" id="rx">엑셀 저장</button></div></div><div id="rt"></div></div>`);
  el.append(card);
  const detail = h(`<div id="repDetail"></div>`);
  el.append(detail);
  let cur = rows;
  let pageSize = 30;
  $$("#rsize button", card).forEach((b) => b.addEventListener("click", () => { pageSize = +b.dataset.n; $$("#rsize button", card).forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  const draw = () => {
    const m = $("#rm", card).value, q = $("#rq", card).value.trim();
    cur = rows.filter((r) => (!m || r.oid === m) && (!q || r.name.includes(q)));
    sortableTable($("#rt", card), [
      { key: "name", label: "기자", html: (r) => `<a href="javascript:void 0" data-rep="${esc(r.name + "|" + r.oid)}"><b>${esc(r.name)}</b></a>` },
      { key: "mname", label: "매체", html: (r) => chip(r.oid) },
      { key: "pub", label: "발행", cls: "r num", html: (r) => (r.pub ? fmt(r.pub) : "-") },
      { key: "rank", label: "랭킹 진입", cls: "r num", html: (r) => fmt(r.rank) },
      { key: "enter", label: "발행 중 20위 진입", cls: "r num", html: (r) => (r.enter == null ? "-" : fmt(r.enter)) },
      { key: "top1", label: "1위", cls: "r num", html: (r) => (r.top1 ? `<span class="tag orange">${r.top1}</span>` : "-") },
      { key: "views", label: "취합 조회수 합계", cls: "r num", val: (r) => (r.viewN ? r.views : -1), html: (r) => (r.viewN ? fmt(r.views) : '<span class="form-hint" title="네이버가 이 매체의 조회수를 공개하지 않습니다">미공개</span>') },
      { key: "bestViews", label: "최고 조회수", cls: "r num", html: (r) => (r.best ? fmt(r.best.views) : "-") },
      { key: "rate", label: "진입률", cls: "r num", html: (r) => (r.rate == null ? "-" : pct(r.rate)) },
      { key: "best", label: "최고 조회 기사", sort: false, html: (r) => (r.best ? `<a href="${articleUrl(r.best.oid, r.best.aid)}" target="_blank" rel="noopener">${esc(r.best.title.slice(0, 34))}${r.best.title.length > 34 ? "…" : ""}</a> <span class="form-hint num">${short(r.best.views)}</span>` : "-") },
    ], cur, { sort: rows.some((r) => r.viewN) ? "views" : "pub", pageSize, rankCol: true, rowClass: (r) => (isOur(r.oid) ? "ours" : "") });
    $$("a[data-rep]", card).forEach((a) => a.addEventListener("click", () => openRep(a.dataset.rep)));
  };
  function openRep(key) {
    const r = map.get(key);
    if (!r) return;
    detail.innerHTML = "";
    const box = h(`<div class="card kw-detail"><div class="card-head"><div><h3>${esc(r.name)} · ${esc(r.mname)}</h3>
      <div class="sub">발행 ${fmt(r.pub)}건 · 랭킹 진입 ${fmt(r.rank)}건 · 1위 ${fmt(r.top1)}회 · 취합 조회수 합계 ${r.viewN ? fmt(r.views) : "미공개"} · 최고 조회수 ${r.best ? fmt(r.best.views) : "-"}</div></div><button class="btn sm" id="rc">닫기</button></div>
      <h4 style="font-size:13px;margin:4px 0 8px">랭킹에 오른 기사</h4><div id="rr"></div>
      ${r.pubItems.length ? `<h4 style="font-size:13px;margin:16px 0 8px">발행 기사 (${fmt(r.pubItems.length)}건)</h4><div id="rp"></div>` : ""}</div>`);
    detail.append(box);
    $("#rc", box).addEventListener("click", () => (detail.innerHTML = ""));
    articleTable($("#rr", box), [...r.rkItems].sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, 50), { showDay: true });
    if (r.pubItems.length) articleTable($("#rp", box), [...r.pubItems].sort((a, b) => (b.day + b.time).localeCompare(a.day + a.time)).slice(0, 100), { showRank: false, showViews: false, showTime: true });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#rm", card).addEventListener("change", draw);
  $("#rq", card).addEventListener("input", debounce(draw, 150));
  $("#rx", card).addEventListener("click", () => ctx.exportSheets(`기자통계_${R.s}_${R.e}`, [{ name: "기자", rows: cur.map((r) => ({ 기자: r.name, 매체: r.mname, 발행: r.pub, 랭킹진입: r.rank, "1위": r.top1, 취합조회수합계: r.viewN ? r.views : "미공개", 최고조회수: r.best?.views ?? "", 발행중20위진입: r.enter ?? "", 진입률: r.rate == null ? "" : +(r.rate * 100).toFixed(1), 최고기사: r.best?.title || "" })) }]));
  draw();
}

// ── 검색 키워드 (키워드 랭킹의 두 번째 탭) ────────────────
const COMP = ["-", "낮음", "중간", "높음"];
async function searchKeywords(el, R, ctx) {
  const A = R.agg;
  const [S, ar, rk] = await Promise.all([R.search(), R.articles(), R.ranking()]);
  if (!S.days.length) {
    el.append(h(`<div class="card">${emptyBox("아직 수집된 검색 키워드 데이터가 없습니다.<br>검색 키워드는 이 기능을 켠 날부터 매일 쌓입니다.")}</div>`));
    return;
  }
  if (S.fallback) el.append(h(`<div class="ok-box">선택한 기간에는 검색 키워드 수집분이 없어 <b>가장 최근 수집분(${S.days.map(dotDate).join(", ")})</b>을 보여줍니다. 발행 건수는 선택 기간 기준입니다.</div>`));
  const nospace = (t) => t.replace(/\s+/g, "").toLowerCase();
  const arT = ar ? ar.map((a) => nospace(a.title)) : null;
  const rkT = rk ? rk.map((a) => [nospace(a.title), a.views]) : null;
  const supply = (w) => {
    const k = nospace(w);
    if (arT) {
      let pub = 0, views = 0;
      for (const t of arT) if (t.includes(k)) pub++;
      for (const [t, v] of rkT || []) if (t.includes(k)) views += v || 0;
      return { pub, views, exact: false };
    }
    const kw = A.kw.get(w);
    return { pub: kw?.pub || 0, views: kw?.views || 0, exact: true };
  };

  // ① 검색량 랭킹 — [네이버 검색량] [구글 검색량] 탭
  const hasN = Object.keys(S.volume).length > 0;
  const hasG = Object.keys(S.gvol).length > 0;
  const nRows = [];
  const groupOf = {};
  const nz = (t) => String(t).replace(/\s+/g, "").toLowerCase();
  for (const [g, ws] of Object.entries(S.seedGroups || {})) for (const w of ws) groupOf[w] ||= g;
  // 연관검색어는 그 분야 관심 키워드가 단어 안에 들어 있을 때만 분야로 묶음 (예: '당뇨' → '당뇨 초기증상' O, '로또' X)
  const relGroup = (w, grp) => { const ws = (S.seedGroups || {})[grp] || []; const k = nz(w); return ws.some((x) => k.includes(nz(x))) ? grp : ""; };
  for (const [w, [pc, mo, comp]] of Object.entries(S.volume)) nRows.push({ word: w, src: S.seeds.has(w) ? "관심" : "제목", group: groupOf[w] || "", pc, mo, comp });
  for (const [w, pc, mo, comp, seed, grp] of S.related.slice(0, 800)) if (!S.volume[w]) nRows.push({ word: w, src: "연관", seed, group: relGroup(w, grp || groupOf[seed] || ""), pc, mo, comp });
  for (const r of nRows) { r.total = r.pc + r.mo; Object.assign(r, supply(r.word)); r.gap = r.total / (r.pub + 1); r.mobile = r.total ? r.mo / r.total : 0; }
  const gRows = Object.entries(S.gvol).map(([w, g]) => ({ word: w, src: S.seeds.has(w) ? "관심" : "제목", group: groupOf[w] || "", g, ...supply(w) }));
  for (const r of gRows) r.gap = r.g / (r.pub + 1);

  // ⓪ 검색 키워드 요약 보고서 (그래프)
  const drawReport = (scope) => {
    const inScope = (r) => scope === "all" ? true : scope === "seed" ? !!r.group : r.group === scope;
    const nTop = nRows.filter(inScope).sort((a, b) => b.total - a.total);
    const gTop = gRows.filter(inScope).sort((a, b) => b.g - a.g);
    // 분야별 검색량 합계 (관심 키워드 + 연관검색어)
    const grp = {};
    for (const r of nRows) if (r.group) { const g = (grp[r.group] ||= { n: 0, total: 0, top: null, rows: [] }); g.n++; g.total += r.total; g.rows.push(r); if (!g.top || r.total > g.top.total) g.top = r; }
    const grpTop = Object.entries(grp).sort((a, b) => b[1].total - a[1].total);
    const trendNo = S.google.filter((x) => !supply(x.title).pub).slice(0, 10);
    const ourHit = S.google.slice(0, 30).filter((x) => supply(x.title).pub).length;
    const rep = h(`<div class="card search-report"><div class="card-head"><div><h3>검색 키워드 요약 보고서 ${info("searchNaver")}</h3>
      <div class="sub">네이버 검색량 ${hasN ? `${dotDate(S.volumeDay)} 조회(최근 30일)` : "키 등록 후 수집"} · 구글 관심도 ${hasG ? `${dotDate(S.gvolDay)} 조회(‘${esc(S.gvolAnchor)}’=100)` : "수집 전"} · 급상승 검색어 ${S.days.map(mmdd).join(", ")} 누적 · 발행 수는 선택 기간 기준</div></div>
      </div>
      <div class="sr-scope" id="srScope"><button class="sr-cfg" data-cfg="1">⚙ 관심 분야 설정</button><button data-s="seed" class="${scope === "seed" ? "on" : ""}">관심 분야 전체</button>${Object.keys(S.seedGroups || {}).map((g) => `<button data-s="${esc(g)}" class="${scope === g ? "on" : ""}">${esc(g)}</button>`).join("")}<button data-s="all" class="${scope === "all" ? "on" : ""}">전체 (기사 제목 키워드 포함)</button></div>
      <div class="grid g-2 sr-split">
        <section class="sr-panel naver">
          <div class="sr-head"><span class="sr-logo n">N</span><b>네이버 키워드 랭킹</b><span class="form-hint">실제 월간 검색 횟수 (검색광고 API)</span></div>
          <div class="grid g-2">
            <div class="card kpi"><div class="label">검색량 1위</div>${nTop[0] ? `<div class="value" style="font-size:22px;color:#03a94d">${esc(nTop[0].word)}</div><div class="meta">월 ${fmt(nTop[0].total)}회 · 키워드 ${fmt(Object.keys(S.volume).length)}개 + 연관 ${fmt(S.related.length)}개</div>` : '<div class="meta">아직 없음</div>'}</div>
            <div class="card kpi"><div class="label">가장 많이 검색된 분야</div>${grpTop[0] ? `<div class="value" style="font-size:22px;color:#03a94d">${esc(grpTop[0][0])}</div><div class="meta">월 ${short(grpTop[0][1].total)}회 · 키워드 ${fmt(grpTop[0][1].n)}개 · 1위 ${esc(grpTop[0][1].top.word)}</div>` : '<div class="meta">수집 후 표시</div>'}</div>
          </div>
          <h4 class="kw-h">월간 검색수 TOP 15 <span class="form-hint">진한 초록 = 모바일 · 연한 초록 = PC(웹)</span></h4><div class="chart-box lg"><canvas id="srN"></canvas></div>
          <h4 class="kw-h">분야별 검색량 <span class="form-hint">관심 키워드 + 연관검색어 월간 검색수 합계</span></h4>
          ${grpTop.length ? `<div class="form-hint" style="margin:-4px 0 6px">분야를 누르면 키워드 전체가 PC·모바일 검색량과 함께 펼쳐집니다</div><table class="t grp-t"><thead><tr><th>분야</th><th class="r">키워드</th><th class="r">월간 검색 합계</th><th>가장 많이 검색된 키워드</th></tr></thead><tbody>${grpTop.map(([g, x]) => `<tr class="grp-row" data-g="${esc(g)}"><td><span class="grp-arrow">▸</span> <b>${esc(g)}</b></td><td class="r num"><u>${fmt(x.n)}개</u></td><td class="r num">${fmt(x.total)}</td><td>${esc(x.top.word)} <span class="form-hint">${short(x.top.total)}</span></td></tr>
            <tr class="grp-detail" data-gd="${esc(g)}" hidden><td colspan="4"><div class="table-wrap" style="max-height:360px;overflow-y:auto"><table class="t"><thead><tr><th class="c">#</th><th>키워드</th><th>구분</th><th class="r">PC(웹)</th><th class="r">모바일</th><th class="r">월간 합계</th><th class="r">모바일 비중</th></tr></thead><tbody>${[...x.rows].sort((a, b) => b.total - a.total).map((r, i) => `<tr><td class="c num">${i + 1}</td><td style="white-space:nowrap"><a href="${ctx.link("keywords", { k: r.word })}"><b>${esc(r.word)}</b></a>${r.seed && r.src === "연관" ? ` <span class="form-hint">← ${esc(r.seed)}</span>` : ""}</td><td style="white-space:nowrap"><span class="tag ${r.src === "관심" ? "green" : "gray"}">${r.src === "관심" ? "관심" : r.src === "연관" ? "연관" : "제목"}</span></td><td class="r num">${fmt(r.pc)}</td><td class="r num">${fmt(r.mo)}</td><td class="r num"><b>${fmt(r.total)}</b></td><td class="r num">${pct(r.mobile, 0)}</td></tr>`).join("")}</tbody></table></div></td></tr>`).join("")}</tbody></table>` : emptyBox("네이버 검색량 수집 후 표시됩니다.")}
        </section>
        <section class="sr-panel google">
          <div class="sr-head"><span class="sr-logo g">G</span><b>구글 키워드 랭킹</b><span class="form-hint">상대 관심도 (‘${esc(S.gvolAnchor)}’=100) · 급상승 검색어</span></div>
          <div class="grid g-2">
            <div class="card kpi"><div class="label">관심도 1위</div>${gTop[0] ? `<div class="value" style="font-size:22px;color:#1a73e8">${esc(gTop[0].word)}</div><div class="meta">${fmt1(gTop[0].g)} · ${fmt(gTop.length)}개 키워드</div>` : '<div class="meta">아직 없음</div>'}</div>
            <div class="card kpi"><div class="label">급상승 검색어</div><div class="value num" style="color:#1a73e8">${fmt(S.google.length)}개</div><div class="meta">${S.google[0] ? `1위 ${esc(S.google[0].title)} ${S.google[0].traffic ? fmt(S.google[0].traffic) + "+" : ""} · ` : ""}TOP 30 중 우리가 쓴 주제 ${ourHit}개</div></div>
          </div>
          <h4 class="kw-h">관심도 TOP 15 <span class="form-hint">‘${esc(S.gvolAnchor)}’ = 100</span></h4><div class="chart-box lg"><canvas id="srG"></canvas></div>
          <h4 class="kw-h">급상승 중인데 우리 기간 기사가 없는 검색어 <span class="form-hint">선택 기간 발행 0건</span></h4>
          ${trendNo.length ? `<table class="t"><thead><tr><th>검색어</th><th class="r">검색량</th><th>관련 뉴스</th></tr></thead><tbody>${trendNo.map((x) => `<tr><td><a href="${ctx.link("keywords", { k: x.title })}"><b>${esc(x.title)}</b></a></td><td class="r num">${x.traffic ? fmt(x.traffic) + "+" : "-"}</td><td class="title">${x.news[0] && /^https?:/.test(x.news[0][1]) ? `<a href="${esc(x.news[0][1])}" target="_blank" rel="noopener">${esc(x.news[0][0])}</a>` : "-"}</td></tr>`).join("")}</tbody></table>` : emptyBox("없음")}
        </section>
      </div></div>`);
    if (repEl) repEl.replaceWith(rep); else el.append(rep);
    repEl = rep;
    $$("#srScope button[data-s]", rep).forEach((b) => b.addEventListener("click", () => drawReport(b.dataset.s)));
    $("#srScope [data-cfg]", rep).addEventListener("click", () => openSeedEditor(rep, S));
    $$(".grp-row", rep).forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const d = $(`.grp-detail[data-gd="${CSS.escape(tr.dataset.g)}"]`, rep);
      d.hidden = !d.hidden;
      $(".grp-arrow", tr).textContent = d.hidden ? "▸" : "▾";
      tr.classList.toggle("open", !d.hidden);
    }));
    const hbar = (id, rows, val, color, f) => rows.length && barChart($(id, rep), rows.map((r) => r.word), [{ label: "", data: rows.map(val), backgroundColor: color }], { horizontal: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => " " + f(c.raw) } } } });
    // 네이버: PC(웹)·모바일을 나눠 쌓은 막대
    if (nTop.length) {
      const top = nTop.slice(0, 15);
      const ch = barChart($("#srN", rep), top.map((r) => r.word), [
        { label: "모바일", data: top.map((r) => r.mo), backgroundColor: "#03a94d" },
        { label: "PC(웹)", data: top.map((r) => r.pc), backgroundColor: "#9be3b8" },
      ], { horizontal: true, stacked: true, plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.raw)}회`, footer: (items) => `합계 ${fmt(top[items[0].dataIndex].total)}회` } } } });
    }
    hbar("#srG", gTop.slice(0, 15), (r) => r.g, "#1a73e8", (v) => `관심도 ${fmt1(v)}`);
    if (!nTop.length) $("#srN", rep).parentElement.innerHTML = emptyBox("네이버 검색량이 아직 없습니다.");
    if (!gTop.length) $("#srG", rep).parentElement.innerHTML = emptyBox("구글 관심도가 아직 없습니다.");
  };
  let repEl = null;
  drawReport("seed");

  const st = { vt: ctx.q.vt === "google" ? "google" : "naver", sort: "", src: "", q: "" };
  const card = h(`<div class="card">
    <div class="board-tabs" id="vtab" style="margin:-4px 0 14px"><button data-v="naver">🟢 네이버 검색량 전체 표</button><button data-v="google">🔵 구글 관심도 전체 표</button></div>
    <div class="card-head"><div><h3 id="vTitle"></h3><div class="sub" id="vSub"></div></div>
      <div class="tools"><input class="input" id="sq" placeholder="검색어 찾기" style="width:130px">
        <select class="input" id="ssrc"></select><div class="seg" id="ssort"></div></div></div>
    <div class="form-hint" id="vHint" style="margin:-6px 0 10px"></div>
    <div id="vSetup"></div><div id="st"></div></div>`);
  el.append(card);
  const bar = (v, max, cls, f) => `<div style="display:flex;gap:8px;align-items:center"><div class="bar ${cls}" style="flex:1"><span style="width:${(v / max) * 100}%"></span></div><span class="num" style="width:56px;text-align:right">${f(v)}</span></div>`;
  const srcTag = (r) => `${r.group ? `<span class="tag orange">${esc(r.group)}</span> ` : ""}<span class="tag ${r.src === "관심" ? "green" : r.src === "제목" ? "blue" : "gray"}">${r.src === "관심" ? "관심" : r.src}</span>`;
  const grpOpts = Object.keys(S.seedGroups || {}).map((g) => ["g:" + g, "분야: " + g]);
  const wordCell = (r) => `<a href="${ctx.link("keywords", { k: r.word })}"><b>${esc(r.word)}</b></a>${r.seed ? `<div class="form-hint">← ${esc(r.seed)}</div>` : ""}`;
  const V = {
    naver: {
      title: `네이버 검색량 랭킹 ${info("searchNaver")}`,
      sub: () => `최근 30일 네이버 실제 검색 횟수 (PC + 모바일)${hasN ? ` · ${dotDate(S.volumeDay)} 조회` : ""} · 발행·조회수는 선택 기간 기준`,
      hint: "월간 검색수 = 최근 30일 네이버 PC + 모바일 실제 검색 횟수. 기간 발행 = 선택 기간에 제목에 그 단어가 들어간 기사 수.",
      sorts: [["total", "검색량"], ["mobile", "모바일 비중"]],
      srcs: [["", "전체"], ...grpOpts, ["관심", "관심 키워드만"], ["연관", "연관 검색어만"], ["제목", "기사 제목 키워드"]],
      rows: nRows,
      setup: hasN ? "" : `<div class="ok-box">네이버 검색량은 <b>네이버 검색광고 API</b>(무료)로 가져옵니다. <a href="https://searchad.naver.com" target="_blank" rel="noopener">searchad.naver.com</a> 가입 → 도구 → API 사용 관리에서 키를 발급받아 GitHub 저장소 Settings → Secrets and variables → Actions 에 <span class="code">NAVER_AD_API_KEY</span>, <span class="code">NAVER_AD_SECRET</span>, <span class="code">NAVER_AD_CUSTOMER_ID</span> 로 등록하면 다음 수집부터 표시됩니다.</div>`,
      table: (list) => { const max = Math.max(...list.map((r) => r.total), 1); return `<thead><tr><th class="c">#</th><th>검색어</th><th>구분</th><th style="min-width:160px">월간 검색수</th><th class="r">PC</th><th class="r">모바일</th><th class="c">광고 경쟁</th><th class="r">기간 발행</th><th class="r">랭킹 조회수</th></tr></thead><tbody>${list.map((r, i) => `<tr><td class="c num">${i + 1}</td><td>${wordCell(r)}</td><td>${srcTag(r)}</td><td>${bar(r.total, max, "", short)}</td><td class="r num">${fmt(r.pc)}</td><td class="r num">${fmt(r.mo)}</td><td class="c">${COMP[r.comp]}</td><td class="r num">${fmt(r.pub)}</td><td class="r num">${r.views ? short(r.views) : "-"}</td></tr>`).join("")}</tbody>`; },
    },
    google: {
      title: `구글 검색량 랭킹 ${info("searchGoogle")}`,
      sub: () => `최근 30일 구글 검색 관심도 · 기준어 ‘${esc(S.gvolAnchor)}’ = 100${hasG ? ` · ${dotDate(S.gvolDay)} 조회` : ""} · 발행·조회수는 선택 기간 기준`,
      hint: "구글은 실제 검색 횟수를 공개하지 않아 기준어 대비 상대값으로 보여줍니다. 150 = 기준어보다 1.5배 많이 검색됨.",
      sorts: [["g", "관심도"]],
      srcs: [["", "전체"], ...grpOpts, ["관심", "관심 키워드만"], ["제목", "기사 제목 키워드"]],
      rows: gRows,
      setup: hasG ? "" : `<div class="ok-box">구글 검색량은 키 없이 <b>GitHub 자동 수집에서 하루 한 번</b> 받아옵니다. 아직 수집 전이라 비어 있어요. 구글이 일시적으로 막으면 다음 수집 때 다시 시도합니다.</div>`,
      table: (list) => { const max = Math.max(...list.map((r) => r.g), 1); return `<thead><tr><th class="c">#</th><th>검색어</th><th>구분</th><th style="min-width:200px">구글 관심도 (기준어=100)</th><th class="r">기간 발행</th><th class="r">랭킹 조회수</th></tr></thead><tbody>${list.map((r, i) => `<tr><td class="c num">${i + 1}</td><td>${wordCell(r)}</td><td>${srcTag(r)}</td><td>${bar(r.g, max, "orange", fmt1)}</td><td class="r num">${fmt(r.pub)}</td><td class="r num">${r.views ? short(r.views) : "-"}</td></tr>`).join("")}</tbody>`; },
    },
  };
  const setTab = () => {
    const v = V[st.vt];
    $$("#vtab button", card).forEach((b) => b.classList.toggle("on", b.dataset.v === st.vt));
    $("#vTitle", card).innerHTML = v.title;
    $("#vSub", card).innerHTML = v.sub();
    $("#vHint", card).textContent = v.hint;
    $("#vSetup", card).innerHTML = v.setup;
    $("#ssrc", card).innerHTML = v.srcs.map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
    st.src = ""; st.sort = v.sorts[0][0];
    $("#ssort", card).innerHTML = v.sorts.map(([k, l]) => `<button data-s="${k}">${l}</button>`).join("");
    $$("#ssort button", card).forEach((b) => b.addEventListener("click", () => { st.sort = b.dataset.s; draw(); }));
    draw();
  };
  const draw = () => {
    const v = V[st.vt];
    $$("#ssort button", card).forEach((b) => b.classList.toggle("on", b.dataset.s === st.sort));
    const list = v.rows.filter((r) => (!st.src || (st.src.startsWith("g:") ? r.group === st.src.slice(2) : r.src === st.src)) && (!st.q || r.word.includes(st.q))).sort((a, b) => b[st.sort] - a[st.sort]).slice(0, 200);
    $("#st", card).innerHTML = list.length ? `<div class="table-wrap" style="max-height:560px;overflow-y:auto"><table class="t">${v.table(list)}</table></div>` : v.setup ? "" : emptyBox("조건에 맞는 검색어가 없습니다.");
  };
  $$("#vtab button", card).forEach((b) => b.addEventListener("click", () => { st.vt = b.dataset.v; ctx.setQuery({ vt: st.vt === "google" ? "google" : "" }); setTab(); }));
  $("#ssrc", card).addEventListener("change", (e) => { st.src = e.target.value; draw(); });
  $("#sq", card).addEventListener("input", debounce((e) => { st.q = e.target.value.trim(); draw(); }, 150));
  setTab();

  // ② 구글 급상승 검색어
  const g = S.google;
  const gcard = h(`<div class="card"><div class="card-head"><div><h3>급상승 검색어 TOP 30 · 구글 ${info("googleTrends")}</h3><div class="sub">구글 트렌드 한국 급상승 검색어 · ${S.days.length}일 누적 · 현재 ${Math.min(30, g.length)}개 · 여러 날 오른 검색어가 위에 옵니다</div></div></div>
    <div id="gTrend"></div>
    <div class="form-hint" style="margin-top:8px">검색량은 구글이 제공하는 대략치(예: 2,000+)입니다. 네이버는 2021년 실시간 검색어를 종료해 급상승 목록을 공식 제공하지 않습니다. 네이버 쪽 흐름은 위 표의 월간 검색수로 확인하세요.</div></div>`);
  el.append(gcard);
  trendPager($("#gTrend", gcard), g.slice(0, 30), (rows) => `<div class="table-wrap"><table class="t"><thead><tr><th class="c">#</th><th>검색어</th><th class="r">최대 검색량</th><th class="c">등장일</th><th>최근</th><th>관련 뉴스</th><th class="r">우리 기간 발행</th></tr></thead><tbody>
    ${rows.map(([x, i]) => {
      const sp = supply(x.title);
      const n = x.news[0];
      return `<tr><td class="c num">${i + 1}</td><td><a href="${ctx.link("keywords", { k: x.title })}"><b>${esc(x.title)}</b></a></td>
        <td class="r num">${x.traffic ? fmt(x.traffic) + "+" : "-"}</td><td class="c num">${x.days.length}일</td><td class="num">${mmdd(x.days[x.days.length - 1])}</td>
        <td class="title">${n && /^https?:/.test(n[1]) ? `<a href="${esc(n[1])}" target="_blank" rel="noopener">${esc(n[0])}</a> <span class="form-hint">${esc(n[2])}</span>` : "-"}</td>
        <td class="r num">${sp.pub ? fmt(sp.pub) : '<span class="tag gray">0</span>'}</td></tr>`;
    }).join("")}</tbody></table></div>`);
}


// 검색 키워드 관심 분야 설정 (관리자: 데이터 수집 권한)
async function openSeedEditor(rep, S) {
  const old = $(".seed-editor", rep);
  if (old) { old.remove(); return; }
  const admin = await adminForSettings().catch(() => null);
  const groups = JSON.parse(JSON.stringify(S.seedGroups || meta().search_seed_groups || {}));
  const box = h(`<div class="seed-editor"><div class="card-head"><div><h3>관심 분야 설정</h3><div class="sub">분야마다 키워드를 쉼표(,)로 구분해 적습니다. 저장하면 바로 검색량을 다시 받아옵니다(2~5분). 네이버는 각 키워드의 연관검색어까지 받아옵니다.</div></div><button class="btn sm" data-x>닫기</button></div>
    ${admin ? "" : '<div class="err-box" style="margin-bottom:10px">🔒 관리자(데이터 수집 권한)만 바꿀 수 있습니다. 관리자 메뉴에서 로그인해 주세요.</div>'}
    <div class="seed-rows"></div>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn sm" data-add ${admin ? "" : "disabled"}>+ 분야 추가</button><button class="btn primary" data-save ${admin ? "" : "disabled"}>💾 저장하고 다시 수집</button><span class="status-line" data-msg></span></div></div>`);
  const rows = $(".seed-rows", box);
  const draw = () => {
    rows.innerHTML = Object.entries(groups).map(([g, ws], i) => `<div class="seed-row" data-i="${i}"><input class="input" data-g value="${esc(g)}" ${admin ? "" : "disabled"}><textarea class="input" data-w rows="2" ${admin ? "" : "disabled"}>${esc(ws.join(", "))}</textarea><button class="btn sm danger" data-del ${admin ? "" : "disabled"}>삭제</button></div>`).join("");
    $$("[data-del]", rows).forEach((b) => b.addEventListener("click", () => { collect(); const k = Object.keys(groups)[+b.closest(".seed-row").dataset.i]; delete groups[k]; draw(); }));
  };
  const collect = () => {
    const out = {};
    $$(".seed-row", rows).forEach((r) => { const g = $("[data-g]", r).value.trim(); const ws = $("[data-w]", r).value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); if (g && ws.length) out[g] = [...new Set(ws)]; });
    Object.keys(groups).forEach((k) => delete groups[k]);
    Object.assign(groups, out);
  };
  $("[data-x]", box).addEventListener("click", () => box.remove());
  $("[data-add]", box).addEventListener("click", () => { collect(); groups["새 분야 " + (Object.keys(groups).length + 1)] = []; draw(); $$(".seed-row [data-g]", rows).pop()?.focus(); });
  $("[data-save]", box).addEventListener("click", async (e) => {
    collect();
    const n = Object.values(groups).flat().length;
    if (!n) return ($("[data-msg]", box).textContent = "키워드를 하나 이상 넣어 주세요.");
    e.target.disabled = true;
    $("[data-msg]", box).textContent = "저장 중…";
    try {
      await saveSeedGroups(groups);
      $("[data-msg]", box).textContent = `저장했습니다 (${Object.keys(groups).length}개 분야 · 키워드 ${n}개). 검색량을 다시 받는 중이에요 — 2~5분 뒤 새로고침하면 반영됩니다.`;
    } catch (err) {
      $("[data-msg]", box).textContent = "저장 실패: " + err.message;
      e.target.disabled = false;
    }
  });
  draw();
  $("#srScope", rep).after(box);
}
