// 공통 유틸
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const fmt = (n) => (n == null || isNaN(n) ? "-" : Math.round(n).toLocaleString("ko-KR"));
export const fmt1 = (n) => (n == null || isNaN(n) ? "-" : (Math.round(n * 10) / 10).toLocaleString("ko-KR"));
export const pct = (n, d = 1) => (n == null || !isFinite(n) ? "-" : (n * 100).toFixed(d) + "%");
export function short(n) {
  if (n == null || isNaN(n)) return "-";
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + "억";
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "만";
  return fmt(n);
}

// ── 날짜 (모두 한국시간 기준) ─────────────────
export function kstToday() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
}
export function dateList(s, e) {
  const out = [];
  for (let d = s; d <= e; d = addDays(d, 1)) out.push(d);
  return out;
}
export function monthList(s, e) {
  const out = [];
  let [y, m] = s.slice(0, 7).split("-").map(Number);
  const [ey, em] = e.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
const WD = "일월화수목금토";
export const weekday = (iso) => WD[new Date(iso + "T00:00:00Z").getUTCDay()];
export const weekdayIdx = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
export const mmdd = (iso) => `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
// 한국 공휴일 (대체공휴일·선거일 포함)
const HOL = {
  "2025-01-01": "신정", "2025-01-27": "임시공휴일", "2025-01-28": "설날 연휴", "2025-01-29": "설날", "2025-01-30": "설날 연휴",
  "2025-03-01": "삼일절", "2025-03-03": "대체공휴일", "2025-05-05": "어린이날·부처님오신날", "2025-05-06": "대체공휴일",
  "2025-06-03": "대통령선거", "2025-06-06": "현충일", "2025-08-15": "광복절", "2025-10-03": "개천절",
  "2025-10-05": "추석 연휴", "2025-10-06": "추석", "2025-10-07": "추석 연휴", "2025-10-08": "대체공휴일", "2025-10-09": "한글날", "2025-12-25": "성탄절",
  "2026-01-01": "신정", "2026-02-16": "설날 연휴", "2026-02-17": "설날", "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절", "2026-03-02": "대체공휴일", "2026-05-05": "어린이날", "2026-05-24": "부처님오신날", "2026-05-25": "대체공휴일",
  "2026-06-03": "전국동시지방선거", "2026-06-06": "현충일", "2026-08-15": "광복절", "2026-08-17": "대체공휴일",
  "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴", "2026-10-03": "개천절", "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날", "2026-12-25": "성탄절",
  "2027-01-01": "신정", "2027-02-06": "설날 연휴", "2027-02-07": "설날", "2027-02-08": "설날 연휴", "2027-02-09": "대체공휴일",
  "2027-03-01": "삼일절", "2027-05-05": "어린이날", "2027-05-13": "부처님오신날", "2027-06-06": "현충일", "2027-08-15": "광복절", "2027-08-16": "대체공휴일",
  "2027-09-14": "추석 연휴", "2027-09-15": "추석", "2027-09-16": "추석 연휴", "2027-10-03": "개천절", "2027-10-04": "대체공휴일",
  "2027-10-09": "한글날", "2027-10-11": "대체공휴일", "2027-12-25": "성탄절", "2027-12-27": "대체공휴일",
};
export const holiday = (iso) => HOL[iso] || "";
// "hol" = 공휴일·일요일(빨강), "sat" = 토요일(파랑), "" = 평일
export const dayKind = (iso) => (HOL[iso] || weekdayIdx(iso) === 0 ? "hol" : weekdayIdx(iso) === 6 ? "sat" : "");
export const DAY_COLOR = { hol: "#dc2626", sat: "#2563eb", "": "#8592a6" };
// 차트 x축용 2줄 라벨: ["10.03", "토·휴"]
export const dayLabel = (iso) => [mmdd(iso), weekday(iso) + (HOL[iso] ? "·휴" : "")];
export const dayTitle = (iso) => `${dotDate(iso)} (${weekday(iso)})${HOL[iso] ? " · " + HOL[iso] : ""}`;
export const dotDate = (iso) => (iso ? iso.slice(0, 10).replace(/-/g, ".") : "");
export function relTime(isoStr) {
  if (!isoStr) return "";
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}
export function kstDateTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(new Date(isoStr).getTime() + 9 * 3600e3).toISOString();
  return `${d.slice(0, 10).replace(/-/g, ".")} ${d.slice(11, 16)}`;
}

// ── 매체 색상 ─────────────────────────────
const PALETTE = ["#2563eb", "#0891b2", "#16a34a", "#9333ea", "#db2777", "#ca8a04", "#0d9488", "#4f46e5", "#dc2626", "#64748b",
  "#0284c7", "#65a30d", "#c026d3", "#b45309", "#475569", "#059669", "#7c3aed", "#e11d48", "#0369a1", "#a16207"];
export const OUR_COLOR = "#f97316";
let colorMap = {};
export function setMediaColors(meta) {
  colorMap = {};
  const all = [...new Set([...(meta.ranking_media || []), ...(meta.publish_media || []), ...Object.keys(meta.media || {})])];
  let i = 0;
  for (const oid of all) colorMap[oid] = oid === meta.our_media ? OUR_COLOR : PALETTE[i++ % PALETTE.length];
}
export const mediaColor = (oid) => colorMap[oid] || "#94a3b8";

export function articleUrl(oid, aid) {
  return `https://n.news.naver.com/article/${oid}/${aid}`;
}

// ── 간단 마크다운 (HTML은 모두 escape → 안전) ──────────
export function markdown(src) {
  const lines = esc(src || "").split(/\r?\n/);
  const out = [];
  let list = null;
  const inline = (s) =>
    s
      .replace(/!\[([^\]]*)\]\(((?:https?:\/\/|data\/)[^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|#|data\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); closeList(); continue; }
    if ((m = line.match(/^(#{2,3})\s+(.*)$/))) { flush(); closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flush(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flush(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    closeList();
    para.push(line);
  }
  flush(); closeList();
  return out.join("\n");
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// 작은 스파크라인 SVG
export function sparkline(values, { w = 90, h = 22, color = "#2563eb" } = {}) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.6" points="${pts}"/></svg>`;
}

// 동적 스크립트 로드 (엑셀 라이브러리 등)
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error("스크립트 로드 실패: " + src));
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}
