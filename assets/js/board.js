// 공지·배너·게시판 (읽기 화면)
import { esc, h, $, $$, markdown, dotDate, kstToday } from "./util.js";

export const TYPES = { notice: "공지", banner: "배너", post: "게시글" };
export const boardTypeLabel = (t) => TYPES[t] || "게시글";

export function isActive(p, today = kstToday()) {
  if (p.visible === false) return false;
  if (p.start && p.start > today) return false;
  if (p.end && p.end < today) return false;
  return true;
}

const byPinnedDate = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.created).localeCompare(String(a.created));

export function activeNotices(board) {
  return (board?.posts || []).filter((p) => p.type === "notice" && isActive(p)).sort(byPinnedDate);
}
export function activeBanners(board) {
  return (board?.posts || []).filter((p) => p.type === "banner" && isActive(p)).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || byPinnedDate(a, b));
}

// 상단 공지 한 줄
export function renderTicker(board) {
  const el = $("#noticeTicker");
  const n = activeNotices(board)[0];
  if (!n) { el.hidden = true; return; }
  el.hidden = false;
  el.href = `#/board/${encodeURIComponent(n.id)}`;
  el.innerHTML = `<b>공지</b><span>${esc(n.title)}</span>`;
}

// 배너 슬라이드
let bannerTimer;
export function renderBanners(slot, board, show) {
  clearInterval(bannerTimer);
  slot.innerHTML = "";
  const hiddenKey = "hideBanners:" + kstToday();
  let hidden = false;
  try { hidden = sessionStorage.getItem(hiddenKey) === "1"; } catch {}
  const list = activeBanners(board);
  if (!show || !list.length || hidden) return;
  const wrap = h(`<div class="banner-wrap"></div>`);
  let idx = 0;
  const draw = () => {
    const p = list[idx];
    const bg = p.image ? `background-image:url('${encodeURI(p.image).replace(/'/g, "%27")}');` : `background:${/^#[0-9a-f]{3,8}$/i.test(p.color || "") ? p.color : "#18335c"};`;
    wrap.innerHTML = `<a class="banner ${p.image ? "has-img" : ""}" style="${bg}" href="#/board/${encodeURIComponent(p.id)}">
        <div><div class="b-kicker">${esc(p.kicker || "NOTICE")}</div><div class="b-title">${esc(p.title)}</div>${p.summary ? `<div class="b-sum">${esc(p.summary)}</div>` : ""}</div>
        <span class="b-go">자세히 보기 →</span></a>
      <button class="banner-close" title="오늘 하루 배너 숨기기">✕</button>
      ${list.length > 1 ? `<div class="banner-dots">${list.map((_, i) => `<button class="${i === idx ? "on" : ""}" data-i="${i}" aria-label="배너 ${i + 1}"></button>`).join("")}</div>` : ""}`;
    $$(".banner-dots button", wrap).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); idx = +b.dataset.i; draw(); }));
    $(".banner-close", wrap).addEventListener("click", () => { try { sessionStorage.setItem(hiddenKey, "1"); } catch {} slot.innerHTML = ""; clearInterval(bannerTimer); });
  };
  draw();
  slot.append(wrap);
  if (list.length > 1) bannerTimer = setInterval(() => { idx = (idx + 1) % list.length; draw(); }, 6000);
}

// 게시판 목록
export function boardList(el, board, ctx) {
  const tab = ctx.q.type || "all";
  const q = ctx.q.q || "";
  el.append(h(`<div class="page-head"><div><h1>공지·게시판</h1><p>편집국 공지와 안내, 배너로 알린 내용을 모아 봅니다.</p></div><a class="btn" href="#/admin">글쓰기 (관리자)</a></div>`));
  const card = h(`<div class="card">
    <div class="card-head"><div class="board-tabs">${[["all", "전체"], ["notice", "공지"], ["banner", "배너"], ["post", "게시글"]].map(([k, l]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <input class="input" id="bq" placeholder="제목·내용 검색" value="${esc(q)}" style="width:200px"></div>
    <div id="bl"></div></div>`);
  el.append(card);
  const draw = () => {
    const t = $(".board-tabs .on", card).dataset.t;
    const qq = $("#bq", card).value.trim().toLowerCase();
    const list = (board.posts || [])
      .filter((p) => p.visible !== false && (t === "all" || p.type === t) && (!qq || (p.title + " " + (p.body || "") + " " + (p.summary || "")).toLowerCase().includes(qq)))
      .sort(byPinnedDate);
    $("#bl", card).innerHTML = list.length
      ? `<table class="t"><thead><tr><th style="width:70px">구분</th><th>제목</th><th style="width:100px">작성자</th><th style="width:100px">등록일</th></tr></thead><tbody>${list
          .map((p) => `<tr><td>${p.pinned ? '<span class="tag orange">필독</span>' : `<span class="tag ${p.type === "notice" ? "blue" : p.type === "banner" ? "green" : "gray"}">${boardTypeLabel(p.type)}</span>`}</td>
          <td class="title"><a href="#/board/${encodeURIComponent(p.id)}"><b>${esc(p.title)}</b></a>${!isActive(p) ? ' <span class="tag gray">게시 종료</span>' : ""}${p.summary ? `<div class="form-hint">${esc(p.summary)}</div>` : ""}</td>
          <td>${esc(p.author_name || p.author || "")}</td><td class="num">${dotDate(p.created)}</td></tr>`)
          .join("")}</tbody></table>`
      : `<div class="empty">게시글이 없습니다.</div>`;
  };
  $$(".board-tabs button", card).forEach((b) => b.addEventListener("click", () => { $$(".board-tabs button", card).forEach((x) => x.classList.toggle("on", x === b)); ctx.setQuery({ type: b.dataset.t }); draw(); }));
  $("#bq", card).addEventListener("input", draw);
  draw();
}

// 게시글 보기
export function boardPost(el, board, id) {
  const p = (board.posts || []).find((x) => x.id === id && x.visible !== false);
  if (!p) {
    el.append(h(`<div class="card"><div class="empty">게시글을 찾을 수 없습니다. 삭제되었거나 아직 반영 중일 수 있습니다(등록 후 1~2분).<br><br><a href="#/board">목록으로</a></div></div>`));
    return;
  }
  const list = (board.posts || []).filter((x) => x.visible !== false).sort(byPinnedDate);
  const i = list.indexOf(p);
  const prev = list[i + 1], next = list[i - 1];
  el.append(h(`<div class="card post-view">
    <div><a href="#/board">← 목록</a></div>
    <div style="margin-top:14px"><span class="tag ${p.type === "notice" ? "blue" : p.type === "banner" ? "green" : "gray"}">${boardTypeLabel(p.type)}</span>${p.pinned ? ' <span class="tag orange">필독</span>' : ""}</div>
    <h1 style="margin-top:8px">${esc(p.title)}</h1>
    <div class="post-meta"><span>${esc(p.author_name || p.author || "관리자")}</span><span>등록 ${dotDate(p.created)}</span>${p.updated && p.updated !== p.created ? `<span>수정 ${dotDate(p.updated)}</span>` : ""}${p.start || p.end ? `<span>게시기간 ${dotDate(p.start) || "…"} ~ ${dotDate(p.end) || "…"}</span>` : ""}</div>
    ${p.image ? `<img class="post-hero" src="${esc(p.image)}" alt="">` : ""}
    ${p.summary ? `<p style="font-size:15.5px;font-weight:600;color:#334155">${esc(p.summary)}</p>` : ""}
    <div class="post-body">${markdown(p.body || "")}</div>
    ${/^https?:\/\//.test(p.link || "") ? `<p style="margin-top:18px"><a class="btn primary" href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.link_text || "바로가기")} →</a></p>` : ""}
    <hr style="border:0;border-top:1px solid var(--line);margin:24px 0 12px">
    <div style="display:flex;justify-content:space-between;gap:10px;font-size:13px">
      <span>${prev ? `← <a href="#/board/${encodeURIComponent(prev.id)}">${esc(prev.title)}</a>` : ""}</span>
      <span>${next ? `<a href="#/board/${encodeURIComponent(next.id)}">${esc(next.title)}</a> →` : ""}</span>
    </div></div>`));
}
