// 관리자 백단 — 아이디·비밀번호 로그인 / 마스터 페이지 / 접속·활동 기록
// 서버 없이 GitHub 저장소를 데이터베이스로 씁니다.
// - 마스터가 처음 한 번 GitHub 키(토큰)를 등록하면, 그 키는 '금고 키'로 암호화되어 data/auth/users.json 에 저장됩니다.
// - 각 계정은 자기 비밀번호로만 금고 키를 열 수 있습니다(PBKDF2 31만 회 + AES-GCM). 비밀번호 원문·GitHub 키 원문은 어디에도 저장되지 않습니다.
// - 접속 기록: data/logs/access/YYYY-MM.json · 활동 기록: data/logs/activity/YYYY-MM.json
import { esc, h, $, $$, markdown, toast, kstToday, dotDate, kstDateTime, relTime, loadScript } from "./util.js";
import { convert, compare } from "./statparse.js";
import { TYPES, isActive } from "./board.js";
import { meta, mediaName } from "./data.js";

const API = "https://api.github.com";
const CFG = window.SITE_CONFIG || {};
const AUTH_PATH = "data/auth/users.json";
const MAX_USERS = 20;
const ITER = 310000;
const SESS_KEY = "nk_sess";
const KEEP_DAYS = 30;
// 계정별 권한: 볼 수 있는 메뉴(접속) + 기능
const permSummary = (p = {}) => {
  const pages = Object.keys(PAGE_PERMS).filter((k) => p[k]);
  const fx = Object.keys(FUNC_PERMS).filter((k) => p[k]);
  const hid = Object.keys(PAGE_PERMS).filter((k) => p["hide_" + k]);
  return `<span class="tag ${pages.length ? "blue" : "gray"}" title="${esc(pages.map((k) => PAGE_PERMS[k]).join(", "))}">메뉴 ${pages.length === Object.keys(PAGE_PERMS).length ? "전체" : pages.length + "개"}</span>${hid.length ? ` <span class="tag gray" title="${esc(hid.map((k) => PAGE_PERMS[k]).join(", "))}">숨김 ${hid.length}</span>` : ""} ${fx.map((k) => `<span class="tag ${k === "download" ? "green" : "orange"}">${FUNC_PERMS[k]}</span>`).join(" ")}`;
};
export const PAGE_PERMS = { dashboard: "뉴스통계 (N)", keywords: "키워드 랭킹", media: "매체 비교", articles: "기사 목록", insights: "작성 인사이트", reporters: "기자 통계", board: "공지·게시판" };
const FUNC_PERMS = { download: "엑셀 다운로드", posts: "게시글·배너·공지 관리", collect: "데이터 수집 실행" };
const PERMS = { ...PAGE_PERMS, ...FUNC_PERMS };
const ALL_PERMS = Object.fromEntries(Object.keys(PERMS).map((k) => [k, true]));
const PRESETS = {
  "보기 전용": { ...Object.fromEntries(Object.keys(PAGE_PERMS).map((k) => [k, true])) },
  "보기 + 다운로드": { ...Object.fromEntries(Object.keys(PAGE_PERMS).map((k) => [k, true])), download: true },
  "관리자 (전체)": ALL_PERMS,
};
const ID_RE = /^[A-Za-z0-9._\-가-힣]{2,20}$/;

export function repoInfo() {
  if (CFG.repo && CFG.repo.includes("/")) {
    const [owner, repo] = CFG.repo.split("/");
    return { owner, repo, branch: CFG.branch || "main" };
  }
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner, repo: seg && !seg.includes(".") ? seg : host, branch: CFG.branch || "main" };
  }
  return null;
}

// ── GitHub API ─────────────────────────
let session = null; // { acct:{id,name,role,perms}, token, k(b64), ver, R }

async function gh(path, opts = {}, token = session?.token) {
  const res = await fetch(API + path, {
    ...opts,
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.message || `GitHub 오류 ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function getFile(path, R = session.R, token = session?.token) {
  const { owner, repo, branch } = R;
  try {
    const f = await gh(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`, {}, token);
    if (f.content === "" && f.size > 0 && f.git_url) {
      const blob = await gh(`/repos/${owner}/${repo}/git/blobs/${f.sha}`, {}, token); // 1MB 넘는 파일
      return { text: b64decode(blob.content), sha: f.sha };
    }
    return { text: b64decode(f.content), sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { text: null, sha: null };
    throw e;
  }
}

async function putFile(path, contentB64, sha, message, R = session.R, token = session?.token) {
  const { owner, repo, branch } = R;
  return gh(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: contentB64, branch, ...(sha ? { sha } : {}) }),
  }, token);
}

// 최신본을 받아 변경을 다시 적용 후 저장 (동시 저장 충돌 시 재시도)
async function updateJSON(path, empty, mutate, message, R, token) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { text, sha } = await getFile(path, R, token);
    let doc = text ? JSON.parse(text) : empty();
    const r = mutate(doc);
    if (r === false) return doc;
    if (doc == null) doc = r;
    doc.updated_at = new Date().toISOString();
    try {
      await putFile(path, b64encode(JSON.stringify(doc, null, 1)), sha, message, R, token);
      return doc;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) { await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); continue; }
      throw e;
    }
  }
}
const who = () => (session ? `${session.acct.name}(${session.acct.id})` : "");
const updateBoard = (mutate, message) => updateJSON("data/board.json", () => ({ posts: [] }), (d) => { d.posts ||= []; return mutate(d); }, `${message} — ${who()}`);

// ── 암호 ─────────────────────────
const te = new TextEncoder();
const toB64 = (u8) => { let s = ""; u8.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function derive(pw, saltB64, iter = ITER) {
  const base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations: iter }, base, 512));
  const vh = hex(await crypto.subtle.digest("SHA-256", bits.slice(0, 32)));
  const key = await crypto.subtle.importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { vh, key };
}
const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
async function seal(key, u8) {
  const iv = rand(12);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, u8))) };
}
async function unseal(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct)));
}
// 비밀번호 → { salt, it, vh, wk(금고 키를 이 비밀번호로 잠근 것) }
async function makeCred(pw, kRaw) {
  const salt = toB64(rand(16));
  const { vh, key } = await derive(pw, salt);
  return { salt, it: ITER, vh, wk: await seal(key, kRaw) };
}
async function sealVault(kRaw, token) {
  return seal(await aesKey(kRaw), te.encode(token));
}
async function openVault(kRaw, vault) {
  return new TextDecoder().decode(await unseal(await aesKey(kRaw), vault));
}
const pwRule = (pw) => (String(pw).length < 8 ? "비밀번호는 8자 이상으로 정해 주세요." : /^\d+$/.test(pw) ? "숫자만으로 된 비밀번호는 쓸 수 없어요. 영문이나 기호를 섞어 주세요." : "");

// ── 계정 파일 ─────────────────────────
// 로그인 전에는 토큰 없이 공개 API로 읽고, 실패하면 배포된 사이트 사본을 읽습니다.
async function loadAuth(R) {
  if (session?.token) {
    const f = await getFile(AUTH_PATH);
    return f.text ? JSON.parse(f.text) : null;
  }
  try {
    const f = await getFile(AUTH_PATH, R, null);
    return f.text ? JSON.parse(f.text) : null;
  } catch {
    const r = await fetch(`${AUTH_PATH}?t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("계정 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return r.json();
  }
}
const findAcct = (doc, id) => {
  const k = String(id || "").trim().toLowerCase();
  if (doc.master && doc.master.id.toLowerCase() === k) return { ...doc.master, role: "master", perms: ALL_PERMS, active: true };
  const u = (doc.users || []).find((x) => x.id.toLowerCase() === k);
  return u ? { ...u, role: "staff" } : null;
};
const updateAuth = (mutate, message) => updateJSON(AUTH_PATH, () => null, mutate, `${message} — ${who()}`);

// ── 세션 보관 ─────────────────────────
function saveSess(remember) {
  const s = JSON.stringify({ id: session.acct.id, ver: session.ver, token: session.token, k: session.k, exp: Date.now() + KEEP_DAYS * 864e5 });
  try {
    sessionStorage.setItem(SESS_KEY, s);
    if (remember) localStorage.setItem(SESS_KEY, s); else localStorage.removeItem(SESS_KEY);
  } catch {}
}
function readSess() {
  try {
    const s = sessionStorage.getItem(SESS_KEY) || localStorage.getItem(SESS_KEY);
    const o = s ? JSON.parse(s) : null;
    return o && o.exp > Date.now() ? o : null;
  } catch { return null; }
}
function clearSess() {
  try { sessionStorage.removeItem(SESS_KEY); localStorage.removeItem(SESS_KEY); localStorage.removeItem("nk_admin_token"); sessionStorage.removeItem("nk_admin_token"); } catch {}
}

// ── 로그인 잠금 (이 브라우저 기준 5번 틀리면 10분) · 실패 기록은 다음 로그인 때 접속 기록에 올림 ──
const FAIL_KEY = "nk_fail";
const failState = () => { try { return JSON.parse(localStorage.getItem(FAIL_KEY) || "{}"); } catch { return {}; } };
const failSave = (o) => { try { localStorage.setItem(FAIL_KEY, JSON.stringify(o)); } catch {} };
function lockCheck(id) {
  const f = failState()[id.toLowerCase()];
  if (f && f.until && f.until > Date.now()) throw new Error(`비밀번호를 5번 틀려 잠겼어요. ${Math.ceil((f.until - Date.now()) / 60000)}분 뒤에 다시 해 주세요.`);
}
function lockFail(id) {
  const o = failState(); const k = id.toLowerCase();
  const f = (o[k] && (!o[k].until || o[k].until > Date.now())) ? o[k] : { n: 0 };
  f.n = (f.n || 0) + 1;
  if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; }
  o[k] = f;
  o._pending = [...(o._pending || []), { t: new Date().toISOString(), id, ua: uaSummary() }].slice(-50);
  failSave(o);
}
function lockClear(id) { const o = failState(); delete o[id.toLowerCase()]; failSave(o); }

// ── 기록 ─────────────────────────
function uaSummary() {
  const u = navigator.userAgent;
  const os = /iPad/.test(u) ? "iPad" : /iPhone/.test(u) ? "iPhone" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "Mac" : /Linux/.test(u) ? "Linux" : "기타";
  const br = /Edg\//.test(u) ? "Edge" : /Whale\//.test(u) ? "Whale" : /SamsungBrowser/.test(u) ? "삼성 인터넷" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "기타";
  return `${br} · ${os}`;
}
const kstYM = () => kstToday().slice(0, 7);
let logQ = Promise.resolve();
function writeLog(kind, entries) {
  if (!session || !entries.length) return logQ;
  const path = `data/logs/${kind}/${kstYM()}.json`;
  const R = session.R, token = session.token, by = who();
  if (!token) return logQ;
  logQ = logQ.then(() =>
    updateJSON(path, () => ({ items: [] }), (d) => { d.items ||= []; d.items.push(...entries); }, `${kind === "access" ? "접속" : "활동"} 기록 — ${by}`, R, token)
  ).catch((e) => console.warn("기록 저장 실패", e));
  return logQ;
}
const entry = (ev, detail = "", extra = {}) => ({ t: new Date().toISOString(), id: session.acct.id, name: session.acct.name, role: session.acct.role, ev, detail, ua: uaSummary(), ...extra });
const logAccess = (ev, detail = "") => writeLog("access", [entry(ev, detail)]);
const logAct = (ev, detail = "") => writeLog("activity", [entry(ev, detail)]);
function flushFails() {
  const o = failState();
  const p = o._pending || [];
  if (!p.length) return;
  delete o._pending; failSave(o);
  writeLog("access", p.map((x) => ({ t: x.t, id: x.id, name: "", role: "", ev: "로그인 실패", detail: "비밀번호 불일치·없는 아이디", ua: x.ua })));
}

// ── 로그인 / 세션 복원 ─────────────────────────
async function checkRepo(token, R) {
  const repo = await gh(`/repos/${R.owner}/${R.repo}`, {}, token);
  if (!repo.permissions?.push) throw new Error("이 GitHub 키에는 저장소 쓰기 권한이 없습니다.");
  return repo;
}

async function login(id, pw, R) {
  id = String(id || "").trim();
  if (!id || !pw) throw new Error("아이디와 비밀번호를 입력하세요.");
  lockCheck(id);
  const doc = await loadAuth(R);
  if (!doc?.master) throw new Error("아직 마스터 계정이 없습니다. 처음 설정을 먼저 해 주세요.");
  const a = findAcct(doc, id);
  if (!a) { lockFail(id); throw new Error("아이디 또는 비밀번호가 맞지 않습니다."); }
  const { vh, key } = await derive(pw, a.salt, a.it || ITER);
  if (vh !== a.vh) { lockFail(id); throw new Error("아이디 또는 비밀번호가 맞지 않습니다."); }
  if (a.active === false) throw new Error("사용 중지된 계정입니다. 마스터에게 문의하세요.");
  if (!a.wk) throw new Error("보안 키가 바뀌어 이 계정의 비밀번호를 다시 정해야 합니다. 마스터에게 비밀번호 재설정을 요청하세요.");
  lockClear(id);
  const kRaw = await unseal(key, a.wk);
  const token = await openVault(kRaw, doc.vault);
  try { await checkRepo(token, R); } catch (e) {
    if (a.role === "master") { session = { acct: pick(a), token: null, k: toB64(kRaw), ver: a.ver || 1, R, expired: true }; return session; }
    throw new Error("사이트의 GitHub 연결이 만료되었거나 끊겼습니다. 마스터에게 ‘GitHub 연결 교체’를 요청하세요.");
  }
  session = { acct: pick(a), token, k: toB64(kRaw), ver: a.ver || 1, R, mustChange: !!a.mustChange };
  return session;
}
const pick = (a) => ({ id: a.id, name: a.name || a.id, role: a.role, perms: a.perms || {} });

async function resume(R) {
  const s = readSess();
  if (!s) return null;
  session = { acct: { id: s.id, name: s.id, role: "staff", perms: {} }, token: s.token, k: s.k, ver: s.ver, R };
  try {
    const doc = await loadAuth(R);
    const a = doc && findAcct(doc, s.id);
    if (!a || a.active === false || (a.ver || 1) !== s.ver || !a.wk) throw new Error("세션 만료");
    session.acct = pick(a);
    session.mustChange = !!a.mustChange;
    if (!sessionStorage.getItem("nk_seen")) { sessionStorage.setItem("nk_seen", "1"); logAccess("재접속", "로그인 유지"); }
    return session;
  } catch {
    session = null;
    clearSess();
    return null;
  }
}

function logout(reason = "로그아웃") {
  if (session?.token) logAccess(reason);
  const q = logQ;
  clearSess();
  try { sessionStorage.removeItem("nk_seen"); } catch {}
  session = null;
  return q;
}

// ═══════════════════════════════════════════════════════
export async function adminPage(el, ctx) {
  el.append(h(`<div class="page-head"><div><h1>관리자</h1><p>아이디·비밀번호로 로그인해 공지·배너·게시글을 등록하고 데이터 수집을 실행합니다. 마스터는 계정(최대 ${MAX_USERS}개)과 접속·활동 기록을 관리합니다.</p></div></div>`));
  const body = h(`<div class="view"></div>`);
  el.append(body);
  const R = repoInfo();
  if (!R) { body.innerHTML = `<div class="err-box">저장소 정보를 알 수 없습니다. assets/js/config.js 의 repo 값을 '소유자/저장소명'으로 설정해 주세요.</div>`; return; }
  if (!session) {
    body.innerHTML = '<div class="card"><div class="loading">로그인 확인 중…</div></div>';
    await resume(R);
  }
  if (session) return homeView(body, ctx);
  let doc = null;
  try { doc = await loadAuth(R); } catch (e) { body.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  if (!doc?.master) return setupView(body, R, ctx, "setup");
  return loginView(body, R, ctx);
}

function loginView(body, R, ctx, note = "", onDone = null) {
  body.innerHTML = "";
  let last = "";
  try { last = localStorage.getItem("nk_last_id") || ""; } catch {}
  const card = h(`<div class="card auth-card">
    <div class="auth-brand"><div class="auth-logo">N</div><div><b>${esc(CFG.siteName || "뉴스 인사이트")}</b><div class="form-hint">로그인</div></div></div>
    ${note ? `<div class="ok-box" style="margin-bottom:12px">${esc(note)}</div>` : ""}
    <div class="auth-fields">
      <input class="input" id="lid" placeholder="아이디" autocomplete="username" value="${esc(last)}">
      <input class="input" id="lpw" type="password" placeholder="비밀번호" autocomplete="current-password">
      <label class="check"><input type="checkbox" id="rm"> 로그인 유지 (${KEEP_DAYS}일 · 공용 PC에서는 체크하지 마세요)</label>
      <button class="btn primary" id="go">로그인</button>
      <div id="msg"></div>
    </div>
    <div class="auth-foot"><a href="javascript:void 0" id="forgot">마스터 비밀번호를 잊으셨나요?</a><span class="form-hint">계정이 없으면 마스터에게 요청하세요</span></div>
  </div>`);
  body.append(card);
  (last ? $("#lpw", card) : $("#lid", card)).focus();
  const go = async () => {
    const id = $("#lid", card).value.trim(), pw = $("#lpw", card).value;
    $("#go", card).disabled = true;
    $("#msg", card).innerHTML = '<span class="status-line">확인 중… (암호 계산에 1~2초 걸려요)</span>';
    try {
      await login(id, pw, R);
      try { localStorage.setItem("nk_last_id", session.acct.id); sessionStorage.setItem("nk_seen", "1"); } catch {}
      if (session.expired) { saveSess(false); return reconnectView(body, ctx, true, onDone); }
      saveSess($("#rm", card).checked);
      logAccess("로그인", $("#rm", card).checked ? "로그인 유지" : "");
      flushFails();
      toast(`${session.acct.name} 님 환영합니다`);
      if (onDone) return onDone(session.acct);
      homeView(body, ctx);
    } catch (e) {
      session = null;
      $("#msg", card).innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
      $("#go", card).disabled = false;
    }
  };
  $("#go", card).addEventListener("click", go);
  $$("#lid,#lpw", card).forEach((x) => x.addEventListener("keydown", (e) => e.key === "Enter" && go()));
  $("#forgot", card).addEventListener("click", () => setupView(body, R, ctx, "recover", onDone));
}

// 처음 설정 · 마스터 비밀번호 복구 (둘 다 저장소 쓰기 권한이 있는 GitHub 키가 필요 = 저장소 주인만 가능)
function setupView(body, R, ctx, mode, onDone = null) {
  body.innerHTML = "";
  const rec = mode === "recover";
  const card = h(`<div class="card auth-card auth-wide">
    <div class="auth-brand"><div class="auth-logo">N</div><div><b>${esc(CFG.siteName || "뉴스 인사이트")} 관리자</b><div class="form-hint">${rec ? "마스터 비밀번호 재설정" : "처음 한 번만 하는 설정 — 마스터 계정 만들기"}</div></div>${rec ? '<button class="btn sm" id="back" style="margin-left:auto">로그인으로</button>' : ""}</div>
    ${rec ? "" : `<div class="auth-steps"><div><b>1</b> 지금 한 번: 마스터 아이디·비밀번호 + GitHub 키 등록</div><div><b>2</b> 마스터가 관리자 아이디(최대 ${MAX_USERS}개) 만들기</div><div><b>3</b> 이후 모두 <b>아이디·비밀번호로만</b> 로그인</div></div>`}
    ${rec ? `<div class="form-hint" style="margin-bottom:10px">저장소 주인만 할 수 있도록 GitHub 키로 본인을 확인합니다. 재설정하면 보안 키가 새로 바뀌어 <b>다른 계정들은 비밀번호를 다시 정해야</b> 합니다(계정·권한은 그대로).</div>` : `<div class="form-hint" style="margin-bottom:10px">이 화면은 한 번만 나옵니다. GitHub 키는 이번에 한 번만 넣으면 되고, 이후 모든 관리자는 아이디·비밀번호로만 로그인합니다.</div>`}
    <ol>
      <li><a href="https://github.com/settings/personal-access-tokens/new?name=news-insight-admin&description=news-insight%20admin%20site&target_name=${encodeURIComponent(R.owner)}&contents=write&actions=write&expires_in=none" target="_blank" rel="noopener">GitHub 키 만들기</a> (${esc(R.owner)} 계정으로 로그인한 상태)</li>
      <li>Repository access → <b>Only select repositories</b> → <b>${esc(R.repo)}</b> 선택</li>
      <li>Permissions가 <b>Contents: Read and write</b>, <b>Actions: Read and write</b>인지 확인 → Generate token → 복사해서 아래에 붙여넣기</li>
    </ol>
    <div class="form-grid" style="margin-top:12px">
      <label for="tk">GitHub 키</label><input class="input" id="tk" type="password" placeholder="github_pat_…" autocomplete="off">
      <label for="mid">마스터 아이디</label><input class="input" id="mid" placeholder="예: admin" value="admin" maxlength="20">
      <label for="mnm">이름</label><input class="input" id="mnm" placeholder="예: 편집국장" value="마스터" maxlength="20">
      <label for="mpw">비밀번호</label><input class="input" id="mpw" type="password" placeholder="8자 이상" autocomplete="new-password">
      <label for="mpw2">비밀번호 확인</label><input class="input" id="mpw2" type="password" autocomplete="new-password">
      <span></span><div class="row"><button class="btn primary" id="go">${rec ? "재설정" : "마스터 계정 만들기"}</button><span id="msg"></span></div>
    </div></div>`);
  body.append(card);
  if (rec) $("#back", card).addEventListener("click", () => loginView(body, R, ctx, "", onDone));
  $("#go", card).addEventListener("click", async () => {
    const token = $("#tk", card).value.trim(), id = $("#mid", card).value.trim(), name = $("#mnm", card).value.trim() || id, pw = $("#mpw", card).value;
    const err = !token ? "GitHub 키를 넣어 주세요." : !ID_RE.test(id) ? "아이디는 2~20자 (한글·영문·숫자·._-)로 정해 주세요." : pwRule(pw) || (pw !== $("#mpw2", card).value ? "비밀번호 확인이 다릅니다." : "");
    if (err) return ($("#msg", card).innerHTML = `<div class="err-box">${esc(err)}</div>`);
    $("#go", card).disabled = true;
    $("#msg", card).innerHTML = '<span class="status-line">확인 중…</span>';
    try {
      await checkRepo(token, R);
      try { await gh(`/repos/${R.owner}/${R.repo}/actions/workflows?per_page=1`, {}, token); } catch { throw new Error("GitHub 키에 Actions: Read and write 권한이 필요합니다."); }
      const kRaw = rand(32);
      const vault = await sealVault(kRaw, token);
      const cred = await makeCred(pw, kRaw);
      const now = new Date().toISOString();
      session = { acct: { id, name, role: "master", perms: ALL_PERMS }, token, k: toB64(kRaw), ver: 1, R };
      let reset = 0;
      await updateAuth((d) => {
        if (d && d.master && !rec) throw new Error("이미 마스터 계정이 있습니다. 로그인 화면에서 로그인하세요.");
        const prev = d || {};
        const ver = ((prev.master && prev.master.ver) || 0) + 1;
        session.ver = ver;
        const users = (prev.users || []).filter((u) => u.id.toLowerCase() !== id.toLowerCase()).map((u) => { reset++; return { ...u, wk: null, salt: null, vh: null, ver: (u.ver || 1) + 1, mustChange: true }; });
        Object.keys(prev).forEach((k) => delete prev[k]);
        Object.assign(prev, { v: 1, created_at: d?.created_at || now, vault, kver: ((d && d.kver) || 0) + 1, master: { id, name, ...cred, ver, created: d?.master?.created || now }, users });
        return prev;
      }, rec ? "마스터 비밀번호 재설정" : "마스터 계정 생성");
      saveSess(false);
      try { localStorage.setItem("nk_last_id", id); sessionStorage.setItem("nk_seen", "1"); } catch {}
      logAccess("로그인", rec ? "GitHub 키로 비밀번호 재설정 후" : "처음 설정");
      logAct(rec ? "마스터 비밀번호 재설정" : "처음 설정", rec ? `보안 키 교체 · 다른 계정 ${reset}개 비밀번호 재설정 필요` : `마스터 계정 ${id} 생성`);
      toast(rec ? "재설정했습니다" : "마스터 계정을 만들었습니다");
      if (onDone) return onDone(session.acct);
      if (!rec) return location.reload();
      homeView(body, ctx);
    } catch (e) {
      session = null;
      $("#msg", card).innerHTML = `<div class="err-box">${esc(e.status === 401 ? "GitHub 키가 올바르지 않습니다." : e.message)}</div>`;
      $("#go", card).disabled = false;
    }
  });
}

// 마스터 로그인 시 GitHub 키가 만료된 경우 / 마스터가 직접 교체할 때
function reconnectView(body, ctx, forced, onDone = null) {
  body.innerHTML = "";
  const R = session.R;
  const card = h(`<div class="card admin-login"><div class="card-head"><div><h3>GitHub 연결 교체</h3><div class="sub">${forced ? "사이트의 GitHub 키가 만료되었거나 삭제되었습니다. 새 키를 넣으면 모든 계정이 그대로 다시 쓸 수 있습니다." : "새 GitHub 키로 바꿉니다. 다른 계정의 비밀번호는 그대로 유지됩니다."}</div></div>${forced ? "" : '<button class="btn sm" id="back">닫기</button>'}</div>
    <ol>
      <li><a href="https://github.com/settings/personal-access-tokens/new?name=news-insight-admin&target_name=${encodeURIComponent(R.owner)}&contents=write&actions=write&expires_in=none" target="_blank" rel="noopener">GitHub 키 만들기</a> → <b>Only select repositories</b> → <b>${esc(R.repo)}</b></li>
      <li><b>Contents</b>, <b>Actions</b> 모두 Read and write → Generate token</li>
    </ol>
    <div class="form-grid"><label for="tk">새 GitHub 키</label><input class="input" id="tk" type="password" placeholder="github_pat_…" autocomplete="off">
    <span></span><div class="row"><button class="btn primary" id="go">교체</button><span id="msg"></span></div></div></div>`);
  body.append(card);
  if (!forced) $("#back", card).addEventListener("click", () => homeView(body, ctx));
  $("#go", card).addEventListener("click", async () => {
    const token = $("#tk", card).value.trim();
    if (!token) return;
    $("#go", card).disabled = true;
    try {
      await checkRepo(token, R);
      const vault = await sealVault(fromB64(session.k), token);
      session.token = token;
      session.expired = false;
      await updateAuth((d) => { d.vault = vault; }, "GitHub 연결 교체");
      saveSess(false);
      if (forced) logAccess("로그인", "GitHub 연결 교체 후");
      logAct("GitHub 연결 교체", "새 GitHub 키 등록");
      toast("GitHub 연결을 교체했습니다");
      if (onDone) return onDone(session.acct);
      homeView(body, ctx);
    } catch (e) {
      $("#msg", card).innerHTML = `<div class="err-box">${esc(e.status === 401 ? "GitHub 키가 올바르지 않습니다." : e.message)}</div>`;
      $("#go", card).disabled = false;
    }
  });
}

// ── 로그인 후 화면 ─────────────────────────
function homeView(body, ctx) {
  body.innerHTML = "";
  const A = session.acct;
  const isM = A.role === "master";
  const tabs = [
    A.perms.posts && ["posts", "게시글·배너·공지"],
    A.perms.collect && ["collect", "데이터 수집"],
    isM && ["stats", "통계 업로드"],
    isM && ["accounts", "계정 관리"],
    isM && ["access", "접속 기록"],
    isM && ["activity", "활동 기록"],
    ["me", "내 정보"],
  ].filter(Boolean);
  const top = h(`<div class="card admin-top">
    <div class="avatar">${esc((A.name || A.id).slice(0, 1))}</div>
    <div><b>${esc(A.name)}</b> <span class="tag ${isM ? "orange" : "blue"}">${isM ? "마스터" : "관리자"}</span><div class="status-line">${esc(A.id)}</div></div>
    <div class="seg admin-tabs" id="atab">${tabs.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div>
    <button class="btn sm" id="logout">로그아웃</button></div>`);
  const pane = h(`<div class="view"></div>`);
  body.append(top, pane);
  $("#logout", top).addEventListener("click", async () => { await logout(); location.reload(); });
  const show = (t) => {
    $$("#atab button", top).forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    pane.innerHTML = "";
    ({ posts: () => postsView(pane, ctx), collect: () => collectView(pane), stats: () => statsView(pane), accounts: () => accountsView(pane), access: () => logView(pane, "access"), activity: () => logView(pane, "activity"), me: () => meView(pane, body, ctx) })[t]();
  };
  $$("#atab button", top).forEach((b) => b.addEventListener("click", () => show(b.dataset.t)));
  if (session.mustChange) {
    toast("처음 받은 비밀번호입니다. 새 비밀번호로 바꿔 주세요.", 4000);
    return show("me");
  }
  show(tabs[0][0]);
}

// ── 계정 관리 (마스터) ─────────────────────────
async function lastLogins() {
  const ym = kstYM();
  const [y, m] = ym.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const out = {};
  for (const p of [prev, ym]) {
    try {
      const f = await getFile(`data/logs/access/${p}.json`);
      (f.text ? JSON.parse(f.text).items || [] : []).forEach((e) => { if (e.ev === "로그인" || e.ev === "재접속") out[e.id.toLowerCase()] = e.t; });
    } catch {}
  }
  return out;
}

async function accountsView(pane) {
  pane.innerHTML = '<div class="card"><div class="loading">계정 불러오는 중…</div></div>';
  let doc, last = {};
  try { [doc, last] = await Promise.all([loadAuth(session.R), lastLogins()]); } catch (e) { pane.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  pane.innerHTML = "";
  const formSlot = h(`<div></div>`);
  const card = h(`<div class="card"><div class="card-head"><div><h3>계정 <span id="cnt"></span></h3><div class="sub">마스터 외 최대 ${MAX_USERS}개 · 계정마다 쓸 수 있는 메뉴를 정합니다 · 사용 중지·비밀번호 재설정 시 그 계정의 기존 로그인은 바로 끊깁니다</div></div><button class="btn primary" id="new">+ 계정 만들기</button></div><div id="al"></div></div>`);
  pane.append(formSlot, card);
  const draw = () => {
    const users = doc.users || [];
    $("#cnt", card).innerHTML = `<span class="tag ${users.length >= MAX_USERS ? "new" : "gray"}">${users.length} / ${MAX_USERS}</span>`;
    $("#new", card).disabled = users.length >= MAX_USERS;
    const m = doc.master;
    const row = (u, isM) => `<tr>
      <td><b>${esc(u.id)}</b></td><td>${esc(u.name || "")}</td>
      <td>${isM ? '<span class="tag orange">마스터 · 전체</span>' : permSummary(u.perms)}</td>
      <td>${isM ? '<span class="tag green">사용</span>' : u.active === false ? '<span class="tag gray">사용 중지</span>' : !u.wk ? '<span class="tag new">비밀번호 재설정 필요</span>' : u.mustChange ? '<span class="tag orange">첫 로그인 전</span>' : '<span class="tag green">사용</span>'}</td>
      <td class="num" style="white-space:nowrap">${last[u.id.toLowerCase()] ? `${kstDateTime(last[u.id.toLowerCase()])}<div class="form-hint">${relTime(last[u.id.toLowerCase()])}</div>` : "-"}</td>
      <td class="num">${dotDate(u.created)}</td>
      <td class="r" style="white-space:nowrap">${isM ? '<span class="form-hint">‘내 정보’에서 변경</span>' : `<button class="btn sm" data-a="edit" data-id="${esc(u.id)}">수정</button> <button class="btn sm" data-a="pw" data-id="${esc(u.id)}">비밀번호 재설정</button> <button class="btn sm" data-a="toggle" data-id="${esc(u.id)}">${u.active === false ? "사용" : "사용 중지"}</button> <button class="btn sm danger" data-a="del" data-id="${esc(u.id)}">삭제</button>`}</td></tr>`;
    $("#al", card).innerHTML = `<div class="table-wrap"><table class="t"><thead><tr><th>아이디</th><th>이름</th><th>권한</th><th>상태</th><th>최근 접속</th><th>만든 날</th><th class="r">관리</th></tr></thead><tbody>${row(m, true)}${users.map((u) => row(u, false)).join("")}</tbody></table></div>${users.length ? "" : '<div class="empty">아직 만든 계정이 없습니다. ‘+ 계정 만들기’로 관리자 아이디를 만들어 주세요.</div>'}`;
    $$("button[data-a]", card).forEach((b) => b.addEventListener("click", () => act(b.dataset.a, b.dataset.id)));
  };
  const save = async (mutate, msg, detail) => {
    try {
      doc = await updateAuth(mutate, msg);
      logAct(msg, detail);
      draw();
      toast("저장했습니다");
      return true;
    } catch (e) { toast("저장 실패: " + e.message, 5000); return false; }
  };
  const act = async (a, id) => {
    const u = doc.users.find((x) => x.id === id);
    if (!u) return;
    if (a === "edit") return form(u);
    if (a === "pw") return form(u, true);
    if (a === "toggle") return save((d) => { const x = d.users.find((y) => y.id === id); x.active = x.active === false; x.ver = (x.ver || 1) + 1; }, u.active === false ? "계정 사용" : "계정 사용 중지", `${u.name}(${u.id})`);
    if (a === "del" && confirm(`‘${u.name}(${u.id})’ 계정을 삭제할까요? 기록은 남습니다.`)) return save((d) => { d.users = d.users.filter((y) => y.id !== id); }, "계정 삭제", `${u.name}(${u.id})`);
  };
  function form(u, pwOnly) {
    const isNew = !u;
    u = u || { id: "", name: "", perms: { ...PRESETS["보기 전용"] } };
    formSlot.innerHTML = "";
    const f = h(`<div class="card"><div class="card-head"><div><h3>${isNew ? "새 계정" : pwOnly ? `비밀번호 재설정 — ${esc(u.name)}(${esc(u.id)})` : `계정 수정 — ${esc(u.id)}`}</h3><div class="sub">${pwOnly || isNew ? "정한 비밀번호를 본인에게 알려 주세요. ‘첫 로그인 때 바꾸기’를 켜 두면 본인이 새 비밀번호로 바꿉니다." : "아이디는 바꿀 수 없습니다."}</div></div><button class="btn sm" id="x">닫기</button></div>
      <div class="form-grid">
        ${pwOnly ? "" : `<label for="uid">아이디</label><input class="input" id="uid" maxlength="20" placeholder="2~20자 (한글·영문·숫자·._-)" value="${esc(u.id)}" ${isNew ? "" : "disabled"}>
        <label for="unm">이름</label><input class="input" id="unm" maxlength="20" placeholder="예: 김기자" value="${esc(u.name)}">
        <label>빠른 선택</label><div class="row">${Object.keys(PRESETS).map((k) => `<button class="btn sm" data-preset="${esc(k)}">${esc(k)}</button>`).join("")}</div>
        <label>메뉴 접근</label><div><div class="menu-perm">${Object.entries(PAGE_PERMS).map(([k, l]) => { const st = u.perms?.[k] ? "on" : u.perms?.["hide_" + k] ? "hide" : "lock"; return `<div class="mp-row"><span>${l}</span><div class="seg sm" data-m="${k}">${[["on", "켬"], ["lock", "잠금"], ["hide", "끔(숨김)"]].map(([v, t]) => `<button type="button" data-v="${v}" class="${st === v ? "on" : ""}">${t}</button>`).join("")}</div></div>`; }).join("")}</div>
          <div class="form-hint">켬 = 볼 수 있음 · 잠금 = 메뉴가 흐리게 보이고 누르면 ‘접근 권한이 없습니다’ · 끔(숨김) = 메뉴가 아예 안 보이고 주소로 들어와도 열리지 않음</div></div>
        <label>기능</label><div class="row">${Object.entries(FUNC_PERMS).map(([k, l]) => `<label class="check"><input type="checkbox" data-p="${k}" ${u.perms?.[k] ? "checked" : ""}> ${l}</label>`).join("")}</div>`}
        ${pwOnly || isNew ? `<label for="upw">비밀번호</label><div class="row"><input class="input" id="upw" type="text" autocomplete="off" placeholder="8자 이상" style="flex:1;min-width:160px"><button class="btn sm" id="gen">자동 생성</button></div>
        <span></span><label class="check"><input type="checkbox" id="umc" checked> 첫 로그인 때 본인이 비밀번호 바꾸기</label>` : ""}
        <span></span><div class="row"><button class="btn primary" id="ok">${isNew ? "만들기" : "저장"}</button><span id="fm" class="status-line"></span></div>
      </div></div>`);
    formSlot.append(f);
    f.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#x", f).addEventListener("click", () => (formSlot.innerHTML = ""));
    const setSeg = (g, v) => $$("button", g).forEach((x) => x.classList.toggle("on", x.dataset.v === v));
    $$(".menu-perm .seg", f).forEach((g) => $$("button", g).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setSeg(g, b.dataset.v); })));
    $$("button[data-preset]", f).forEach((b) => b.addEventListener("click", () => { const P = PRESETS[b.dataset.preset]; $$("input[data-p]", f).forEach((c) => (c.checked = !!P[c.dataset.p])); $$(".menu-perm .seg", f).forEach((g) => setSeg(g, P[g.dataset.m] ? "on" : "lock")); }));
    $("#gen", f)?.addEventListener("click", () => {
      const cs = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const r = rand(10); let s = ""; r.forEach((b) => (s += cs[b % cs.length]));
      $("#upw", f).value = s.slice(0, 5) + "-" + s.slice(5);
    });
    $("#ok", f).addEventListener("click", async () => {
      const id = isNew ? $("#uid", f).value.trim() : u.id;
      const name = pwOnly ? u.name : $("#unm", f).value.trim() || id;
      const perms = pwOnly ? u.perms : Object.fromEntries($$("input[data-p]", f).map((c) => [c.dataset.p, c.checked]));
      if (!pwOnly) for (const g of $$(".menu-perm .seg", f)) { const v = $("button.on", g)?.dataset.v || "lock"; perms[g.dataset.m] = v === "on"; perms["hide_" + g.dataset.m] = v === "hide"; }
      const pw = $("#upw", f)?.value;
      let err = "";
      if (isNew && !ID_RE.test(id)) err = "아이디는 2~20자 (한글·영문·숫자·._-)로 정해 주세요.";
      else if (isNew && /^(admin|master|root|관리자|마스터)$/i.test(id) && id.toLowerCase() !== "") err = "admin·master 같은 아이디는 쓸 수 없어요.";
      else if (isNew && (doc.master.id.toLowerCase() === id.toLowerCase() || doc.users.some((x) => x.id.toLowerCase() === id.toLowerCase()))) err = "이미 있는 아이디입니다.";
      else if (isNew && doc.users.length >= MAX_USERS) err = `계정은 최대 ${MAX_USERS}개까지 만들 수 있어요.`;
      else if ((isNew || pwOnly) && pwRule(pw)) err = pwRule(pw);
      if (err) return ($("#fm", f).innerHTML = `<span class="err-box" style="display:inline-block;padding:4px 8px">${esc(err)}</span>`);
      $("#ok", f).disabled = true;
      $("#fm", f).textContent = "저장 중…";
      const cred = isNew || pwOnly ? await makeCred(pw, fromB64(session.k)) : null;
      const mc = $("#umc", f)?.checked;
      const ok = await save((d) => {
        d.users ||= [];
        if (isNew) {
          if (d.users.length >= MAX_USERS) throw new Error(`계정은 최대 ${MAX_USERS}개까지입니다.`);
          if (d.users.some((x) => x.id.toLowerCase() === id.toLowerCase())) throw new Error("이미 있는 아이디입니다.");
          d.users.push({ id, name, perms, active: true, ...cred, ver: 1, mustChange: mc, created: new Date().toISOString(), createdBy: session.acct.id });
        } else {
          const x = d.users.find((y) => y.id === id);
          if (!x) throw new Error("계정이 없습니다.");
          if (pwOnly) Object.assign(x, cred, { ver: (x.ver || 1) + 1, mustChange: mc });
          else Object.assign(x, { name, perms });
        }
      }, isNew ? "계정 생성" : pwOnly ? "비밀번호 재설정" : "계정 수정", `${name}(${id})${pwOnly ? "" : " · 권한: " + (Object.entries(perms).filter(([, v]) => v).map(([k]) => PERMS[k]).join(", ") || "없음")}`);
      if (ok) {
        formSlot.innerHTML = "";
        if (isNew || pwOnly) formSlot.append(h(`<div class="ok-box" style="margin-bottom:12px">${esc(name)} 님 계정 정보 — 아이디 <b>${esc(id)}</b> · 비밀번호 <b class="code">${esc(pw)}</b> · 접속 주소 ${esc(location.origin + location.pathname)}#/admin<br><span class="form-hint">이 창을 닫으면 비밀번호는 다시 볼 수 없습니다.</span></div>`));
      } else { $("#ok", f).disabled = false; $("#fm", f).textContent = ""; }
    });
  }
  $("#new", card).addEventListener("click", () => form(null));
  draw();
}

// ── 접속 / 활동 기록 (마스터) ─────────────────────────
async function logView(pane, kind) {
  const title = kind === "access" ? "접속 기록" : "활동 기록";
  const card = h(`<div class="card"><div class="card-head"><div><h3>${title}</h3><div class="sub">${kind === "access" ? "로그인 · 로그인 유지 재접속 · 로그아웃 · 로그인 실패(다음 로그인 때 함께 기록)" : "게시글·배너·공지 등록/수정/삭제, 이미지 업로드, 수집 실행, 계정·비밀번호 변경"}</div></div>
    <div class="row" style="gap:6px;flex-wrap:wrap"><select class="input" id="ym"></select><select class="input" id="who"><option value="">전체 계정</option></select><select class="input" id="ev"><option value="">전체 구분</option></select><input class="input" id="q" placeholder="내용 검색" style="width:130px"><button class="btn sm" id="csv">엑셀(CSV)</button></div></div>
    <div id="lb"><div class="loading"></div></div></div>`);
  pane.append(card);
  const { owner, repo, branch } = session.R;
  let months = [];
  try {
    const ls = await gh(`/repos/${owner}/${repo}/contents/data/logs/${kind}?ref=${branch}`);
    months = (ls || []).map((x) => x.name.replace(".json", "")).filter((x) => /^\d{4}-\d{2}$/.test(x)).sort().reverse();
  } catch {}
  if (!months.includes(kstYM())) months.unshift(kstYM());
  $("#ym", card).innerHTML = months.map((m) => `<option value="${m}">${m.replace("-", "년 ")}월</option>`).join("");
  let items = [];
  const draw = () => {
    const w = $("#who", card).value, ev = $("#ev", card).value, q = $("#q", card).value.trim();
    const rows = items.filter((e) => (!w || e.id === w) && (!ev || e.ev === ev) && (!q || `${e.detail} ${e.name} ${e.id}`.includes(q)));
    $("#lb", card).innerHTML = rows.length
      ? `<div class="form-hint" style="margin-bottom:6px">${rows.length}건</div><div class="table-wrap"><table class="t"><thead><tr><th>일시</th><th>아이디</th><th>이름</th><th>구분</th>${kind === "activity" ? "<th>내용</th>" : "<th>메모</th>"}<th>기기</th></tr></thead><tbody>${rows
          .map((e) => `<tr><td class="num" style="white-space:nowrap">${kstDateTime(e.t)}</td><td>${esc(e.id)}</td><td>${esc(e.name || "")}${e.role === "master" ? ' <span class="tag orange">M</span>' : ""}</td><td><span class="tag ${/실패|삭제|중지/.test(e.ev) ? "new" : /로그아웃/.test(e.ev) ? "gray" : "blue"}">${esc(e.ev)}</span></td><td class="title">${esc(e.detail || "")}</td><td class="form-hint" style="white-space:nowrap">${esc(e.ua || "")}</td></tr>`)
          .join("")}</tbody></table></div>`
      : '<div class="empty">기록이 없습니다.</div>';
  };
  const load = async () => {
    $("#lb", card).innerHTML = '<div class="loading"></div>';
    try {
      const f = await getFile(`data/logs/${kind}/${$("#ym", card).value}.json`);
      items = (f.text ? JSON.parse(f.text).items || [] : []).sort((a, b) => String(b.t).localeCompare(String(a.t)));
    } catch (e) { items = []; $("#lb", card).innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
    const ids = [...new Set(items.map((e) => e.id))].sort();
    const evs = [...new Set(items.map((e) => e.ev))].sort();
    const keepW = $("#who", card).value, keepE = $("#ev", card).value;
    $("#who", card).innerHTML = `<option value="">전체 계정</option>${ids.map((x) => `<option ${x === keepW ? "selected" : ""}>${esc(x)}</option>`).join("")}`;
    $("#ev", card).innerHTML = `<option value="">전체 구분</option>${evs.map((x) => `<option ${x === keepE ? "selected" : ""}>${esc(x)}</option>`).join("")}`;
    draw();
  };
  $("#ym", card).addEventListener("change", load);
  $$("#who,#ev", card).forEach((x) => x.addEventListener("change", draw));
  $("#q", card).addEventListener("input", draw);
  $("#csv", card).addEventListener("click", () => {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["일시(KST)", "아이디", "이름", "구분", "내용", "기기"].join(",")].concat(items.map((e) => [kstDateTime(e.t), e.id, e.name, e.ev, e.detail, e.ua].map(cell).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `${title}_${$("#ym", card).value}.csv`;
    a.click();
    logAct("기록 내려받기", `${title} ${$("#ym", card).value}`);
  });
  load();
}

// ── 내 정보 (비밀번호 변경 · 마스터 아이디/이름 변경 · GitHub 연결 교체) ──
function meView(pane, body, ctx) {
  const A = session.acct, isM = A.role === "master";
  const card = h(`<div class="card admin-login"><div class="card-head"><div><h3>내 정보</h3><div class="sub">${session.mustChange ? '<b style="color:var(--red)">처음 받은 비밀번호입니다. 새 비밀번호로 바꿔 주세요.</b>' : "비밀번호를 바꾸면 다른 기기의 로그인은 끊깁니다."}</div></div></div>
    <div class="form-grid">
      <label>아이디</label>${isM ? `<input class="input" id="mid" maxlength="20" value="${esc(A.id)}">` : `<div><b>${esc(A.id)}</b></div>`}
      <label>이름</label>${isM ? `<input class="input" id="mnm" maxlength="20" value="${esc(A.name)}">` : `<div>${esc(A.name)}</div>`}
      <label>권한</label><div>${isM ? "마스터 (전체 + 계정 관리 + 기록)" : Object.entries(PERMS).filter(([k]) => A.perms[k]).map(([, l]) => l).join(", ") || "없음"}</div>
      <label for="cpw">지금 비밀번호</label><input class="input" id="cpw" type="password" autocomplete="current-password">
      <label for="npw">새 비밀번호</label><input class="input" id="npw" type="password" autocomplete="new-password" placeholder="${isM ? "바꾸지 않으려면 비워 두세요" : "8자 이상"}">
      <label for="npw2">새 비밀번호 확인</label><input class="input" id="npw2" type="password" autocomplete="new-password">
      <span></span><div class="row"><button class="btn primary" id="ok">저장</button><span id="fm"></span></div>
    </div></div>`);
  pane.append(card);
  if (isM) {
    const gc = h(`<div class="card admin-login"><div class="card-head"><div><h3>GitHub 연결</h3><div class="sub">사이트가 저장소에 글·기록을 쓸 때 쓰는 키입니다. 만료되었거나 바꾸고 싶을 때 교체하세요. (다른 계정 비밀번호는 그대로)</div></div><button class="btn sm" id="rc">GitHub 연결 교체</button></div>
      <div class="form-hint">퇴사 등으로 계정을 완전히 막아야 할 때: 계정을 삭제한 뒤 GitHub에서 기존 키를 삭제하고 여기서 새 키로 교체하세요.</div></div>`);
    pane.append(gc);
    $("#rc", gc).addEventListener("click", () => reconnectView(body, ctx, false));
  }
  $("#ok", card).addEventListener("click", async () => {
    const cur = $("#cpw", card).value, np = $("#npw", card).value;
    const nid = isM ? $("#mid", card).value.trim() : A.id;
    const nnm = isM ? $("#mnm", card).value.trim() || nid : A.name;
    const msg = (t, ok) => ($("#fm", card).innerHTML = `<span class="${ok ? "ok-box" : "err-box"}" style="display:inline-block;padding:4px 8px">${esc(t)}</span>`);
    if (!cur) return msg("지금 비밀번호를 넣어 주세요.");
    if (session.mustChange && !np) return msg("새 비밀번호를 정해 주세요.");
    if (np && pwRule(np)) return msg(pwRule(np));
    if (np && np !== $("#npw2", card).value) return msg("새 비밀번호 확인이 다릅니다.");
    if (np && np === cur) return msg("지금과 다른 비밀번호로 정해 주세요.");
    if (isM && !ID_RE.test(nid)) return msg("아이디는 2~20자 (한글·영문·숫자·._-)로 정해 주세요.");
    $("#ok", card).disabled = true;
    $("#fm", card).innerHTML = '<span class="status-line">확인 중…</span>';
    try {
      const doc = await loadAuth(session.R);
      const a = findAcct(doc, A.id);
      if (!a || (await derive(cur, a.salt, a.it || ITER)).vh !== a.vh) throw new Error("지금 비밀번호가 맞지 않습니다.");
      if (isM && nid.toLowerCase() !== A.id.toLowerCase() && (doc.users || []).some((u) => u.id.toLowerCase() === nid.toLowerCase())) throw new Error("다른 계정이 쓰는 아이디입니다.");
      const cred = np ? await makeCred(np, fromB64(session.k)) : null;
      let ver = session.ver;
      await updateAuth((d) => {
        const x = isM ? d.master : d.users.find((u) => u.id === A.id);
        if (!x) throw new Error("계정이 없습니다.");
        if (cred) { Object.assign(x, cred); x.ver = (x.ver || 1) + 1; x.mustChange = false; }
        if (isM) { x.id = nid; x.name = nnm; }
        ver = x.ver || 1;
      }, np ? "비밀번호 변경" : "내 정보 변경");
      const changes = [isM && nid !== A.id && `아이디 ${A.id}→${nid}`, isM && nnm !== A.name && `이름 ${A.name}→${nnm}`, np && "비밀번호 변경"].filter(Boolean).join(" · ");
      logAct(np ? "비밀번호 변경" : "내 정보 변경", changes || "변경 없음");
      session.ver = ver;
      session.mustChange = false;
      session.acct = { ...A, id: nid, name: nnm };
      let remember = false; try { remember = !!localStorage.getItem(SESS_KEY); } catch {}
      saveSess(remember);
      try { localStorage.setItem("nk_last_id", nid); } catch {}
      toast("저장했습니다");
      homeView(body, ctx);
    } catch (e) {
      msg(e.message);
      $("#ok", card).disabled = false;
    }
  });
}

async function resizeImage(file, maxW = 1600) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, maxW / img.width);
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  const dataUrl = c.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.86);
  return { dataUrl, ext: file.type === "image/png" ? "png" : "jpg" };
}

async function uploadImage(file) {
  const { dataUrl, ext } = await resizeImage(file);
  const b64 = dataUrl.split(",")[1];
  if (b64.length > 4_000_000) throw new Error("이미지가 너무 큽니다 (3MB 이하로 줄여 주세요).");
  const name = `data/uploads/${kstToday().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await putFile(name, b64, null, `이미지 업로드 ${name} — ${who()}`);
  logAct("이미지 업로드", name);
  return { path: name, dataUrl };
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#18335c");

// ── 게시글 관리 ─────────────────────────
async function postsView(pane, ctx) {
  pane.innerHTML = '<div class="card"><div class="loading">게시글 불러오는 중…</div></div>';
  let doc;
  try {
    const f = await getFile("data/board.json");
    doc = f.text ? JSON.parse(f.text) : { posts: [] };
  } catch (e) {
    pane.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  pane.innerHTML = "";
  const listCard = h(`<div class="card"><div class="card-head"><div><h3>등록된 글</h3><div class="sub">배너·공지를 누르면 연결되는 게시판 글을 여기서 관리합니다</div></div><button class="btn primary" id="new">+ 새 글</button></div><div id="pl"></div></div>`);
  const editorSlot = h(`<div></div>`);
  pane.append(editorSlot, listCard);

  const status = (p) => {
    if (p.visible === false) return '<span class="tag gray">숨김</span>';
    const t = kstToday();
    if (p.start && p.start > t) return '<span class="tag blue">예약</span>';
    if (p.end && p.end < t) return '<span class="tag gray">종료</span>';
    return '<span class="tag green">게시중</span>';
  };
  const drawList = () => {
    const posts = [...(doc.posts || [])].sort((a, b) => String(b.created).localeCompare(String(a.created)));
    $("#pl", listCard).innerHTML = posts.length
      ? `<div class="table-wrap"><table class="t"><thead><tr><th>구분</th><th>제목</th><th>상태</th><th>게시기간</th><th>작성</th><th class="r">관리</th></tr></thead><tbody>${posts
          .map((p) => `<tr><td><span class="tag">${TYPES[p.type] || p.type}</span>${p.pinned ? ' <span class="tag orange">필독</span>' : ""}</td>
            <td class="title"><a href="#/board/${encodeURIComponent(p.id)}" target="_blank">${esc(p.title)}</a></td>
            <td>${status(p)}</td><td class="num" style="white-space:nowrap">${dotDate(p.start) || "-"} ~ ${dotDate(p.end) || "-"}</td>
            <td style="white-space:nowrap">${esc(p.author || "")}<div class="form-hint">${dotDate(p.updated || p.created)}</div></td>
            <td class="r" style="white-space:nowrap"><button class="btn sm" data-a="edit" data-id="${esc(p.id)}">수정</button> <button class="btn sm" data-a="toggle" data-id="${esc(p.id)}">${p.visible === false ? "공개" : "숨김"}</button> <button class="btn sm danger" data-a="del" data-id="${esc(p.id)}">삭제</button></td></tr>`)
          .join("")}</tbody></table></div>`
      : '<div class="empty">아직 글이 없습니다. ‘새 글’로 첫 공지를 등록해 보세요.</div>';
    $$("button[data-a]", listCard).forEach((b) => b.addEventListener("click", () => act(b.dataset.a, b.dataset.id)));
  };
  const commit = async (mutate, msg) => {
    try {
      doc = await updateBoard(mutate, msg);
      const [ev, ...rest] = msg.split(": ");
      logAct(ev, rest.join(": "));
      ctx.setBoard(doc);
      drawList();
      toast("저장했습니다. 1~2분 후 사이트 전체에 반영됩니다.");
      return true;
    } catch (e) {
      toast("저장 실패: " + e.message, 5000);
      return false;
    }
  };
  const act = async (a, id) => {
    const p = doc.posts.find((x) => x.id === id);
    if (!p) return;
    if (a === "edit") return editor(p);
    if (a === "toggle") return commit((d) => { const x = d.posts.find((y) => y.id === id); if (x) x.visible = x.visible === false; }, `게시글 ${p.visible === false ? "공개" : "숨김"}: ${p.title}`);
    if (a === "del" && confirm(`‘${p.title}’ 글을 삭제할까요? 되돌릴 수 없습니다.`)) return commit((d) => { d.posts = d.posts.filter((y) => y.id !== id); }, `게시글 삭제: ${p.title}`);
  };

  function editor(p) {
    const isNew = !p;
    p = p ? { ...p } : { id: newId(), type: "notice", title: "", summary: "", body: "", visible: true, pinned: false, color: "#18335c", kicker: "" };
    editorSlot.innerHTML = "";
    const f = h(`<div class="card"><div class="card-head"><div><h3>${isNew ? "새 글 작성" : "글 수정"}</h3><div class="sub">배너·공지를 클릭하면 이 글이 게시판에서 열립니다</div></div><button class="btn sm" id="cancel">닫기</button></div>
      <div class="form-grid">
        <label>구분</label><div class="row">${Object.entries(TYPES).map(([k, l]) => `<label class="check"><input type="radio" name="type" value="${k}" ${p.type === k ? "checked" : ""}> ${l}</label>`).join("")}
          <span class="form-hint">공지: 상단 알림줄·대시보드 공지 / 배너: 화면 상단 큰 띠 / 게시글: 게시판에만</span></div>
        <label for="f-title">제목 *</label><input class="input" id="f-title" maxlength="120" value="${esc(p.title)}">
        <label for="f-sum">요약</label><input class="input" id="f-sum" maxlength="160" placeholder="배너 부제 / 목록에 보이는 한 줄" value="${esc(p.summary || "")}">
        <label class="bn" for="f-kicker">배너 머리말</label><input class="input bn" id="f-kicker" maxlength="30" placeholder="예: 이달의 기획 / EVENT" value="${esc(p.kicker || "")}">
        <label class="bn" for="f-color">배너 배경</label><div class="row bn"><input type="color" id="f-color" value="${safeColor(p.color)}"><span class="form-hint">이미지가 없을 때 사용 · 배너 순서</span><input class="input" type="number" id="f-order" style="width:70px" value="${p.order ?? ""}" placeholder="1"></div>
        <label>이미지</label><div class="row"><input type="file" id="f-file" accept="image/*"><input class="input" id="f-img" style="flex:1;min-width:200px" placeholder="이미지 주소 (업로드하면 자동 입력)" value="${esc(p.image || "")}"><img id="f-prev" class="img-preview" ${p.image ? `src="${esc(p.image)}"` : "hidden"} alt=""></div>
        <label for="f-body">본문</label><div class="full" style="grid-column:auto"><textarea class="input" id="f-body" style="width:100%" placeholder="## 소제목&#10;- 목록&#10;**굵게**, [링크](https://...)">${esc(p.body || "")}</textarea>
          <div class="form-hint">간단한 서식: ## 소제목 · - 목록 · **굵게** · [글자](주소) · 줄바꿈 그대로 반영</div></div>
        <label for="f-link">바로가기 링크</label><div class="row"><input class="input" id="f-link" style="flex:1;min-width:200px" placeholder="https://… (선택)" value="${esc(p.link || "")}"><input class="input" id="f-linkt" style="width:150px" placeholder="버튼 문구" value="${esc(p.link_text || "")}"></div>
        <label>게시 기간</label><div class="row"><input class="input" type="date" id="f-start" value="${esc(p.start || "")}"> ~ <input class="input" type="date" id="f-end" value="${esc(p.end || "")}"><span class="form-hint">비우면 계속 게시 · 기간이 지나면 배너/알림에서 자동으로 내려갑니다</span></div>
        <label>옵션</label><div class="row"><label class="check"><input type="checkbox" id="f-pin" ${p.pinned ? "checked" : ""}> 필독(맨 위 고정)</label><label class="check"><input type="checkbox" id="f-vis" ${p.visible !== false ? "checked" : ""}> 공개</label></div>
        <span></span><div class="row"><button class="btn primary" id="save">${isNew ? "등록" : "저장"}</button><button class="btn" id="preview">미리보기</button><span id="fmsg" class="status-line"></span></div>
      </div><div id="pv" style="margin-top:16px"></div></div>`);
    editorSlot.append(f);
    f.scrollIntoView({ behavior: "smooth", block: "start" });
    const syncType = () => {
      const t = $('input[name="type"]:checked', f).value;
      $$(".bn", f).forEach((x) => (x.style.display = t === "banner" ? "" : "none"));
    };
    $$('input[name="type"]', f).forEach((r) => r.addEventListener("change", syncType));
    syncType();
    $("#cancel", f).addEventListener("click", () => (editorSlot.innerHTML = ""));
    $("#f-img", f).addEventListener("change", (e) => { const v = e.target.value.trim(); const im = $("#f-prev", f); im.hidden = !v; if (v) im.src = v; });
    $("#f-file", f).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("#fmsg", f).textContent = "이미지 업로드 중…";
      try {
        const { path, dataUrl } = await uploadImage(file);
        $("#f-img", f).value = path;
        const im = $("#f-prev", f);
        im.src = dataUrl;
        im.hidden = false;
        $("#fmsg", f).textContent = "업로드 완료 (사이트 반영 1~2분)";
      } catch (err) {
        $("#fmsg", f).textContent = "업로드 실패: " + err.message;
      }
    });
    const read = () => {
      const v = (id) => $(id, f).value.trim();
      const link = v("#f-link");
      const img = v("#f-img");
      return {
        ...p,
        type: $('input[name="type"]:checked', f).value,
        title: v("#f-title"),
        summary: v("#f-sum"),
        kicker: v("#f-kicker"),
        color: safeColor($("#f-color", f).value),
        order: v("#f-order") ? Number(v("#f-order")) : undefined,
        image: /^(https?:\/\/|data\/uploads\/)/.test(img) ? img : "",
        body: $("#f-body", f).value,
        link: /^https?:\/\//.test(link) ? link : "",
        link_text: v("#f-linkt"),
        start: v("#f-start"),
        end: v("#f-end"),
        pinned: $("#f-pin", f).checked,
        visible: $("#f-vis", f).checked,
      };
    };
    $("#preview", f).addEventListener("click", () => {
      const x = read();
      $("#pv", f).innerHTML = `<div class="post-view" style="border-top:1px dashed var(--line);padding-top:14px"><h1>${esc(x.title)}</h1>${x.image ? `<img class="post-hero" src="${esc($("#f-prev", f).src)}">` : ""}<div class="post-body">${markdown(x.body)}</div></div>`;
    });
    $("#save", f).addEventListener("click", async () => {
      const x = read();
      if (!x.title) return toast("제목을 입력해 주세요");
      if (x.start && x.end && x.start > x.end) return toast("게시 종료일이 시작일보다 빠릅니다");
      const now = new Date().toISOString();
      x.updated = now;
      x.created ||= now;
      x.author ||= session.acct.id;
      x.author_name ||= session.acct.name;
      x.editor = session.acct.id;
      $("#save", f).disabled = true;
      $("#fmsg", f).textContent = "저장 중…";
      const ok = await commit((d) => {
        const i = d.posts.findIndex((y) => y.id === x.id);
        if (i >= 0) d.posts[i] = x; else d.posts.push(x);
      }, `${isNew ? "게시글 등록" : "게시글 수정"}: ${x.title}`);
      if (ok) editorSlot.innerHTML = "";
      else { $("#save", f).disabled = false; $("#fmsg", f).textContent = ""; }
    });
  }

  $("#new", listCard).addEventListener("click", () => editor(null));
  drawList();
}

// ── 데이터 수집 실행 ─────────────────────
async function collectView(pane) {
  const { owner, repo, branch } = session.R;
  const wf = CFG.collectWorkflow || "collect.yml";
  const M = meta();
  const today = kstToday();
  const card = h(`<div class="card"><div class="card-head"><div><h3>수집 실행</h3><div class="sub">GitHub Actions에서 수집기가 실행됩니다 (자동 수집은 30분마다). 과거 기간을 채울 때도 여기서 실행하세요.</div></div></div>
    <div class="form-grid">
      <label>기간</label><div class="row"><input class="input" type="date" id="cs" value="${today}"> ~ <input class="input" type="date" id="ce" value="${today}"><span class="form-hint">비우면 어제~오늘. 한 번에 31일 이하 권장</span></div>
      <label>종류</label><div class="row"><select class="input" id="co"><option value="">랭킹 + 발행목록</option><option value="ranking">랭킹만</option><option value="publish">발행목록만</option></select></div>
      <span></span><div class="row"><button class="btn primary" id="run">수집 시작</button><span id="cmsg" class="status-line"></span></div>
    </div></div>`);
  const runs = h(`<div class="card"><div class="card-head"><div><h3>최근 실행 기록</h3><div class="sub">마지막 데이터 갱신: ${M.updated_at ? `${kstDateTime(M.updated_at)} (${relTime(M.updated_at)})` : "-"}</div></div><a href="https://github.com/${esc(owner)}/${esc(repo)}/actions" target="_blank" rel="noopener">Actions 열기</a></div><div id="rl"><div class="loading"></div></div></div>`);
  pane.append(card, runs);
  $("#run", card).addEventListener("click", async () => {
    const s = $("#cs", card).value, e = $("#ce", card).value;
    if (s && e && s > e) return toast("시작일이 종료일보다 늦습니다");
    $("#run", card).disabled = true;
    try {
      await gh(`/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`, { method: "POST", body: JSON.stringify({ ref: branch, inputs: { start: s || "", end: e || "", only: $("#co", card).value } }) });
      logAct("수집 실행", `${s || "어제"} ~ ${e || "오늘"} · ${$("#co", card).selectedOptions[0].textContent}`);
      $("#cmsg", card).innerHTML = '<span class="tag green">요청됨</span> 몇 분 뒤 완료되면 사이트가 자동 갱신됩니다.';
      setTimeout(loadRuns, 3000);
    } catch (err) {
      $("#cmsg", card).innerHTML = `<span class="err-box" style="display:inline-block;padding:4px 8px">${esc(err.status === 403 || err.status === 404 ? "토큰에 Actions: Read and write 권한이 필요합니다." : err.message)}</span>`;
    } finally {
      $("#run", card).disabled = false;
    }
  });
  async function loadRuns() {
    try {
      const r = await gh(`/repos/${owner}/${repo}/actions/workflows/${wf}/runs?per_page=8`);
      const lab = { success: '<span class="tag green">성공</span>', failure: '<span class="tag new">실패</span>', cancelled: '<span class="tag gray">취소</span>' };
      $("#rl", runs).innerHTML = r.workflow_runs?.length
        ? `<table class="t"><thead><tr><th>시작</th><th>방식</th><th>상태</th><th></th></tr></thead><tbody>${r.workflow_runs.map((w) => `<tr><td>${kstDateTime(w.created_at)}</td><td>${w.event === "schedule" ? "자동" : w.event === "workflow_dispatch" ? "수동" : esc(w.event)}</td><td>${w.status !== "completed" ? '<span class="tag blue">진행중</span>' : lab[w.conclusion] || esc(w.conclusion)}</td><td class="r"><a href="${esc(w.html_url)}" target="_blank" rel="noopener">로그</a></td></tr>`).join("")}</tbody></table>`
        : '<div class="empty">실행 기록이 없습니다.</div>';
    } catch (e) {
      $("#rl", runs).innerHTML = `<div class="form-hint">실행 기록을 보려면 토큰에 Actions 읽기 권한이 필요합니다. (${esc(e.message)})</div>`;
    }
  }
  loadRuns();
  if (M.last_run?.errors?.length) runs.append(warnBox(M.last_run));
}

// ── 통계 업로드 (마스터 전용) ─────────────────────
// 엑셀을 브라우저에서 읽어 사이트 형식(JSON)으로 바꾼 뒤 저장소에 올리고, 반영 작업(uploads.yml)을 실행합니다.
// 사이트가 직접 수집한 데이터가 우선이고, 업로드 파일은 수집이 비어 있는 곳만 채웁니다.
const STAT_DIR = "data/uploads/stats";
const KIND = { ranking: "랭킹", publish: "발행", mixed: "랭킹+발행", other: "기타 표" };
const ST = { fill: '<span class="tag green">채움</span>', same: '<span class="tag blue">일치</span>', diff: '<span class="tag orange">차이</span>' };
const bufB64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function siteData(days) {
  const get = (p) => fetch(`${p}?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const site = { ranking: {}, counts: {}, articles: {} };
  await Promise.all(days.flatMap((d) => ["ranking", "counts", "articles"].map(async (k) => (site[k][d] = await get(`data/${k}/${d}.json`)))));
  return site;
}
async function deleteFile(path, message) {
  const { owner, repo, branch } = session.R;
  const { sha } = await getFile(path);
  if (!sha) return;
  await gh(`/repos/${owner}/${repo}/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message, sha, branch }) });
}
async function runUploadsJob() {
  const { owner, repo, branch } = session.R;
  try { await gh(`/repos/${owner}/${repo}/actions/workflows/uploads.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: branch }) }); return true; } catch (e) { console.warn(e); return false; }
}

async function statsView(pane) {
  if (session.acct.role !== "master") { pane.innerHTML = '<div class="empty">마스터 계정만 쓸 수 있습니다.</div>'; return; }
  const M = meta();
  const nameToOid = Object.fromEntries(Object.entries(M.media || {}).map(([o, n]) => [String(n).replace(/\s+/g, ""), o]));
  const card = h(`<div class="card"><div class="card-head"><div><h3>통계 업로드 <span class="tag orange">마스터 전용</span></h3>
      <div class="sub">따로 모은 통계 엑셀(랭킹·발행 기사 등)을 올리면 사이트 데이터에 보완합니다. 사이트가 매일 직접 수집한 값이 우선이고, <b>수집이 비어 있는 날짜·매체만</b> 업로드 값으로 채웁니다. 값이 다르면 바꾸지 않고 '차이'로 보여 줍니다.</div></div></div>
    <label class="up-drop" id="drop"><input type="file" id="uf" accept=".xlsx,.xls,.csv" multiple hidden>
      <b>📄 엑셀 파일을 끌어다 놓거나 눌러서 고르세요</b><span class="form-hint">여러 개 한 번에 가능 · .xlsx / .xls / .csv · 파일 1개 10MB 이하</span></label>
    <div class="form-hint" style="margin-top:8px">읽을 수 있는 형식 — <b>랭킹</b>: 날짜·제목·조회수·링크 열이 있는 시트 · <b>발행</b>: 발행일·발행시각·제목·링크 열이 있는 시트, 매체_요약 시트의 발행건수 · 매체는 네이버 기사 링크의 언론사 코드로 알아냅니다. 그 밖의 표는 원본 그대로 보관만 합니다.</div>
    <div id="prev"></div></div>`);
  const hist = h(`<div class="card"><div class="card-head"><div><h3>업로드 기록</h3><div class="sub">올린 파일과 반영 결과 · 기록을 지우면 그 파일로 채웠던 데이터도 되돌립니다(직접 수집한 데이터는 그대로)</div></div><button class="btn sm" id="hr">새로고침</button></div><div id="hl"><div class="loading"></div></div></div>`);
  pane.append(card, hist);
  let pending = [];

  const preview = async (files) => {
    const box = $("#prev", card);
    box.innerHTML = '<div class="loading">파일 읽는 중…</div>';
    try { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"); } catch (e) { box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
    const X = window.XLSX;
    pending = [];
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name}: 10MB를 넘어 건너뜁니다`, 4000); continue; }
      try {
        const buf = await f.arrayBuffer();
        const wb = X.read(buf, { cellDates: true });
        const sheets = wb.SheetNames.map((n) => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) }));
        const doc = convert(sheets, { fileName: f.name, nameToOid });
        const cmp = doc.days.length ? compare(doc, await siteData(doc.days)) : [];
        pending.push({ f, buf, doc, cmp });
      } catch (e) { toast(`${f.name}: 읽지 못했습니다 (${e.message})`, 5000); }
    }
    if (!pending.length) { box.innerHTML = ""; return; }
    const cnt = (c, s) => c.filter((x) => x.status === s).length;
    box.innerHTML = pending.map(({ f, doc, cmp }, i) => `<div class="up-file">
        <div class="up-head"><b>${esc(f.name)}</b> <span class="tag blue">${KIND[doc.kind]}</span>
          <span class="form-hint">${doc.days.length ? `${esc(doc.days[0])}${doc.days.length > 1 ? " ~ " + esc(doc.days[doc.days.length - 1]) : ""} (${doc.days.length}일)` : "날짜 없음"} · 매체 ${Object.keys(doc.media).length}곳 · 읽은 시트 ${doc.sheets_used.length}개${doc.other.length ? ` · 보관만 하는 표 ${doc.other.length}개` : ""}</span>
          ${cmp.length ? `<span class="up-sum">채움 ${cnt(cmp, "fill")} · 일치 ${cnt(cmp, "same")} · 차이 ${cnt(cmp, "diff")}</span>` : ""}</div>
        ${cmp.length ? `<div class="tbl-wrap" style="max-height:320px;overflow:auto"><table class="t"><thead><tr><th>날짜</th><th>구분</th><th>매체</th><th class="r">업로드</th><th class="r">사이트 수집</th><th>결과</th><th>설명</th></tr></thead><tbody>
          ${cmp.map((x) => `<tr><td class="num">${esc(x.day)}</td><td>${x.type}</td><td>${esc(doc.media[x.oid] || mediaName(x.oid))}</td><td class="r num">${esc(x.upload)}</td><td class="r num">${esc(x.site)}</td><td>${ST[x.status]}</td><td class="form-hint">${x.status === "fill" ? "사이트에 없음 → 업로드 값으로 채움" : esc(x.note || "")}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="form-hint">사이트 데이터와 연결할 표를 찾지 못했습니다. 올리면 원본과 표 미리보기만 보관됩니다.</div>`}
        <button class="btn sm" data-x="${i}" style="margin-top:6px">이 파일 빼기</button></div>`).join("") +
      `<div class="row" style="margin-top:12px"><button class="btn primary" id="go">⬆ ${pending.length}개 파일 업로드하고 반영</button><span class="status-line" id="gmsg"></span></div>`;
    $$("[data-x]", box).forEach((b) => b.addEventListener("click", () => { pending.splice(+b.dataset.x, 1); pending.length ? preview(pending.map((p) => p.f)) : (box.innerHTML = ""); }));
    $("#go", box).addEventListener("click", upload);
  };

  const upload = async () => {
    const btn = $("#go", card), msg = $("#gmsg", card);
    btn.disabled = true;
    const done = [];
    try {
      const ix = await getFile(`${STAT_DIR}/index.json`);
      const prev = ix.text ? JSON.parse(ix.text).uploads || [] : [];
      const dup = pending.filter((p) => prev.some((u) => u.name === p.f.name && u.size === p.f.size));
      if (dup.length && !confirm(`이미 올린 파일이 있습니다:\n${dup.map((p) => "· " + p.f.name).join("\n")}\n\n같은 파일은 빼고 올릴까요? (취소 = 업로드 중단)`)) { btn.disabled = false; return; }
      pending = pending.filter((p) => !dup.includes(p));
      if (!pending.length) { msg.textContent = "새로 올릴 파일이 없습니다 (모두 이미 올린 파일)."; btn.disabled = false; return; }
      for (const [i, p] of pending.entries()) {
        msg.textContent = `올리는 중… (${i + 1}/${pending.length}) ${p.f.name}`;
        const id = `${kstToday().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
        const ext = (p.f.name.match(/\.(xlsx|xls|csv)$/i)?.[1] || "xlsx").toLowerCase();
        const raw = `${STAT_DIR}/raw/${id}.${ext}`;
        const at = new Date().toISOString();
        const doc = { ...p.doc, id, at, by: `${session.acct.name}(${session.acct.id})`, raw };
        await putFile(raw, bufB64(p.buf), null, `통계 업로드 원본: ${p.f.name} — ${who()}`);
        await putFile(`${STAT_DIR}/${id}.json`, b64encode(JSON.stringify(doc)), null, `통계 업로드: ${p.f.name} — ${who()}`);
        const c = p.cmp;
        await updateJSON(`${STAT_DIR}/index.json`, () => ({ uploads: [] }), (d) => {
          d.uploads ||= [];
          d.uploads.unshift({ id, name: p.f.name, at, by: doc.by, kind: doc.kind, days: doc.days, media: Object.keys(doc.media).length, raw, size: p.f.size, preview: { fill: c.filter((x) => x.status === "fill").length, same: c.filter((x) => x.status === "same").length, diff: c.filter((x) => x.status === "diff").length } });
        }, `통계 업로드 기록 — ${who()}`);
        logAct("통계 업로드", `${p.f.name} · ${KIND[doc.kind]} · ${doc.days[0] || ""}${doc.days.length > 1 ? "~" + doc.days[doc.days.length - 1] : ""}`);
        done.push(p.f.name);
      }
      const ok = await runUploadsJob();
      msg.innerHTML = `<span class="tag green">완료</span> ${done.length}개 올림 · ${ok ? "반영 작업을 시작했습니다. 2~3분 뒤 사이트에 보입니다." : "다음 자동 수집 때 반영됩니다 (반영 작업 실행 권한 없음)."}`;
      pending = [];
      setTimeout(loadHist, 1500);
    } catch (e) {
      msg.innerHTML = `<span class="err-box" style="display:inline-block;padding:4px 8px">업로드 실패: ${esc(e.message)}${done.length ? ` (먼저 올린 ${done.length}개는 저장됨)` : ""}</span>`;
    } finally { btn.disabled = false; }
  };

  const drop = $("#drop", card), inp = $("#uf", card);
  inp.addEventListener("change", () => inp.files.length && preview([...inp.files]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("on"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("on"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("on"); const fs = [...e.dataTransfer.files].filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name)); fs.length ? preview(fs) : toast("엑셀(.xlsx/.xls/.csv) 파일만 올릴 수 있어요"); });

  async function loadHist() {
    const box = $("#hl", hist);
    box.innerHTML = '<div class="loading"></div>';
    try {
      const [ix, ap] = await Promise.all([getFile(`${STAT_DIR}/index.json`), getFile(`${STAT_DIR}/applied.json`)]);
      const list = ix.text ? JSON.parse(ix.text).uploads || [] : [];
      const app = ap.text ? JSON.parse(ap.text) : { uploads: {} };
      if (!list.length) { box.innerHTML = '<div class="empty">아직 올린 파일이 없습니다.</div>'; return; }
      const { owner, repo, branch } = session.R;
      box.innerHTML = `<table class="t"><thead><tr><th>올린 시각</th><th>파일</th><th>종류</th><th>기간</th><th>올린 사람</th><th>반영 결과</th><th></th></tr></thead><tbody>${list.map((u) => {
        const a = app.uploads?.[u.id];
        const res = a ? `<span class="tag green">반영 완료</span> 채움 ${a.filled.length} · 일치 ${a.same} · 차이 ${a.diff.length}${a.diff.length ? `<div class="form-hint">차이: ${esc(a.diff.slice(0, 4).map((x) => `${x.day.slice(5)} ${mediaName(x.oid)} ${x.type} 사이트 ${x.site ?? "-"} / 파일 ${x.upload ?? "-"}`).join(", "))}</div>` : ""}<div class="form-hint">${esc(kstDateTime(a.at))} 반영${a.filled.length ? " · 채움: " + esc(a.filled.slice(0, 6).map((x) => `${x.day.slice(5)} ${mediaName(x.oid)} ${x.type}`).join(", ")) + (a.filled.length > 6 ? " …" : "") : ""}</div>` : '<span class="tag blue" style="white-space:nowrap">반영 중</span> <button class="btn sm" data-run="1">지금 반영</button>';
        return `<tr><td class="num" style="white-space:nowrap">${esc(kstDateTime(u.at))}</td><td class="title">${esc(u.name)}</td><td style="white-space:nowrap">${KIND[u.kind] || esc(u.kind)}</td><td class="num" style="white-space:nowrap">${esc((u.days || [])[0] || "-")}${u.days?.length > 1 ? " ~ " + esc(u.days[u.days.length - 1]) : ""}</td><td style="white-space:nowrap">${esc(u.by || "")}</td><td style="white-space:nowrap">${res}</td>
          <td class="r" style="white-space:nowrap"><a class="btn sm" href="https://raw.githubusercontent.com/${esc(owner)}/${esc(repo)}/${esc(branch)}/${esc(u.raw)}" download="${esc(u.name)}">원본</a> <button class="btn sm" data-del="${esc(u.id)}">삭제</button></td></tr>`;
      }).join("")}</tbody></table>
      <div class="form-hint" style="margin-top:8px">채움 = 사이트에 없던 데이터를 업로드 값으로 넣음 · 일치 = 사이트 수집값과 같음(검증됨) · 차이 = 값이 달라 사이트 수집값 유지</div>`;
      $$("[data-run]", box).forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        const ok = await runUploadsJob();
        toast(ok ? "반영 작업을 시작했습니다. 2~3분 뒤 '새로고침'을 눌러 보세요." : "반영 작업을 시작하지 못했습니다. 다음 자동 수집(30분 이내) 때 반영됩니다.", 5000);
      }));
      if (list.some((u) => !app.uploads?.[u.id])) setTimeout(() => document.body.contains(box) && loadHist(), 60000); // 반영 중이면 1분마다 자동 새로고침
      $$("[data-del]", box).forEach((b) => b.addEventListener("click", async () => {
        const u = list.find((x) => x.id === b.dataset.del);
        if (!confirm(`"${u.name}" 업로드를 지울까요?\n이 파일로 채웠던 데이터도 사이트에서 빠집니다.`)) return;
        b.disabled = true;
        try {
          await deleteFile(`${STAT_DIR}/${u.id}.json`, `통계 업로드 삭제: ${u.name} — ${who()}`);
          if (u.raw) await deleteFile(u.raw, `통계 업로드 원본 삭제: ${u.name} — ${who()}`);
          await updateJSON(`${STAT_DIR}/index.json`, () => ({ uploads: [] }), (d) => { d.uploads = (d.uploads || []).filter((x) => x.id !== u.id); }, `통계 업로드 기록 삭제 — ${who()}`);
          logAct("통계 업로드 삭제", u.name);
          await runUploadsJob();
          toast("지웠습니다. 2~3분 뒤 사이트에 반영됩니다.", 4000);
          loadHist();
        } catch (e) { toast("삭제 실패: " + e.message, 5000); b.disabled = false; }
      }));
    } catch (e) { box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
  }
  $("#hr", hist).addEventListener("click", loadHist);
  loadHist();
}

// ── 수집 경고: 원인별 묶음 + 개선 방법, 목록은 30줄 높이로 스크롤 ──
const REASON = {
  timeout: ["느림 (시간 초과)", "네이버 기사 페이지가 12초 안에 응답하지 않았습니다. 한꺼번에 많은 기사(연합뉴스·뉴스1은 하루 2천~3천 건)를 확인할 때 생깁니다.", "자동으로 20초 쉬고 적은 동시 요청으로 한 번 더 확인합니다. 그래도 남으면 다음 수집(3시간마다 전체 수집, 매일 7:30)에서 다시 확인하므로 대부분 채워집니다."],
  "429": ["접근 제한 (요청 과다)", "짧은 시간에 요청이 너무 많아 네이버가 잠시 응답을 막았습니다(HTTP 429).", "자동으로 쉬었다가 천천히 다시 시도합니다. 계속 나오면 동시 요청 수(collector/config.json의 workers, 지금 12)를 6~8로 낮추세요."],
  "403": ["접근 거부 (403)", "네이버가 이 요청을 거부했습니다. 수집 서버(GitHub) 주소가 일시적으로 막혔을 가능성이 큽니다.", "보통 몇 시간 뒤 풀립니다. 하루 이상 계속되면 수집 간격을 늘리거나 동시 요청 수를 낮추세요."],
  "404": ["기사 없음 (삭제·404)", "목록에는 있었지만 기사 페이지가 삭제되었거나 주소가 바뀌었습니다.", "정상적인 경우가 많아 따로 조치할 필요가 없습니다(통계에서 자동 제외)."],
  "5xx": ["네이버 서버 오류 (5xx)", "네이버 쪽 일시 오류입니다.", "자동으로 다시 시도하고, 다음 수집에서 다시 확인합니다."],
  conn: ["연결 끊김", "응답 도중 연결이 끊겼습니다(네트워크 일시 오류).", "자동으로 다시 시도합니다."],
  sports: ["스포츠 기사 (형식 다름)", "스포츠 기사는 스포츠 전용 페이지로 넘어가는데, 그 페이지는 날짜가 화면에 그려진 뒤에야 보여 수집기가 날짜를 읽지 못합니다.", "10/8 개선: 스포츠 페이지 안에 들어 있는 기사 정보(입력 시각·바이라인)를 읽도록 고쳤습니다. 이후 수집부터는 이 원인이 거의 사라지고, 빠졌던 날도 다음 전체 수집에서 채워집니다."],
  entertain: ["연예 기사 (형식 다름)", "연예 기사는 연예 전용 페이지로 넘어가 날짜 표시를 찾지 못했습니다.", "10/8 개선: 연예 페이지 안의 기사 정보(입력 시각·바이라인)를 읽도록 고쳤습니다. 이후 수집부터는 이 원인이 거의 사라집니다."],
  nodate: ["날짜 표시 없음", "페이지는 열렸지만 기사 입력 시각 표시를 찾지 못했습니다(페이지 형식 변경·특수 기사).", "건수가 많으면 페이지 형식이 바뀐 것이니 수집기 점검이 필요합니다."],
  other: ["기타", "분류되지 않은 오류입니다.", "로그를 확인해 주세요."],
};
function warnBox(run) {
  const errs = run.errors || [];
  const cnt = {};
  let rank0 = 0;
  for (const e of errs) {
    const m = e.match(/원인:\s*(.+)$/);
    if (m) for (const part of m[1].split(",")) { const [k, n] = part.trim().split("×"); cnt[k] = (cnt[k] || 0) + (+n || 1); }
    else if (/: 0건/.test(e)) rank0++;
  }
  const kinds = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  const pubFail = errs.filter((e) => /상세 확인 실패/.test(e)).length, bndFail = errs.filter((e) => /경계 확인 실패/.test(e)).length;
  const box = h(`<div class="warn-wrap"><div class="card-head" style="margin:0 0 8px"><div><h3 style="font-size:15px">최근 수집 경고 ${fmtN(run.errors_n || errs.length)}건 <span class="form-hint">${esc(kstDateTime(run.at || ""))}</span></h3>
      <div class="sub">경고가 있어도 그때까지 모은 데이터는 저장되며, 빠진 부분은 다음 수집에서 다시 확인합니다.</div></div></div>
    <div class="warn-what">
      ${pubFail ? `<div><b>발행목록 · 상세 확인 실패</b> — 기사마다 상세 페이지를 열어 입력 시각·기자명을 확인하는데, 확인하지 못한 기사는 엉뚱한 날짜에 들어가지 않도록 그 수집에서 뺍니다.</div>` : ""}
      ${bndFail ? `<div><b>발행 건수 · 경계 확인 실패</b> — 목록의 최근 기사는 날짜가 '3일 전'처럼 표시돼, 그날의 첫 기사·마지막 기사만 상세 페이지로 확인해 범위를 자릅니다. 그 확인이 실패하면 그날 건수를 확정하지 않고 비워 둡니다(틀린 숫자 대신 빈칸).</div>` : ""}
      ${rank0 ? `<div><b>랭킹 0건</b> — 그날 네이버 랭킹이 비어 있거나 페이지 형식이 바뀐 경우입니다.</div>` : ""}
    </div>
    ${kinds.length ? `<table class="t warn-t"><thead><tr><th>원인</th><th class="r">건수</th><th>무슨 뜻인가요</th><th>개선 방법</th></tr></thead><tbody>${kinds.map(([k, n]) => { const r = REASON[k] || REASON.other; return `<tr><td style="white-space:nowrap"><b>${esc(r[0])}</b></td><td class="r num">${fmtN(n)}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`; }).join("")}</tbody></table>`
      : `<div class="form-hint">이 경고들은 원인 분류 전에 기록됐습니다. 10/8 점검 결과 상세 확인·경계 확인 실패는 거의 모두 <b>스포츠·연예 기사</b>(네이버가 스포츠·연예 전용 페이지로 넘겨 날짜 표시가 다름) 때문이었고, 느림이나 접근 차단은 아니었습니다(표본 24건 모두 정상 응답 0.5~2초). 스포츠·연예 페이지의 입력 시각을 읽도록 고쳤으며, 다음 수집부터 원인별로 나뉘어 기록됩니다.</div>`}
    <div class="warn-list">${errs.map((e) => `<div>${esc(e.replace(/\s*\|\s*원인:.*$/, ""))}${/원인:/.test(e) ? ` <span class="form-hint">(${esc(e.match(/원인:\s*(.+)$/)[1].split(",").map((p) => { const [k, n] = p.trim().split("×"); return `${(REASON[k] || REASON.other)[0]} ${n}`; }).join(", "))})</span>` : ""}</div>`).join("")}</div>
    ${(run.errors_n || 0) > errs.length ? `<div class="form-hint">전체 ${fmtN(run.errors_n)}건 중 ${fmtN(errs.length)}건 표시</div>` : ""}</div>`);
  return box;
}
const fmtN = (n) => Number(n || 0).toLocaleString("ko-KR");

// ── 다른 화면에서 쓰는 관리자 기능 (뉴스통계 (N) > 매체 설정) ──
export async function adminForSettings() {
  const R = repoInfo();
  if (!R) return null;
  if (!session) await resume(R);
  return session?.token && (session.acct.role === "master" || session.acct.perms.collect) ? session.acct : null;
}
export async function saveSiteSettings(view) {
  if (!session?.token) throw new Error("관리자 로그인이 필요합니다.");
  await updateJSON("data/settings.json", () => ({}), (d) => { d.view = view; d.by = session.acct.id; }, `표시 매체 기본값 변경 — ${who()}`);
  logAct("표시 매체 기본값 변경", `랭킹 ${view.rank.length}곳 · 발행 ${view.pub.length}곳`);
}


// ── 사이트 전체 접속 관리 (main.js에서 사용) ──
// configured: 마스터 계정이 만들어졌는지 (만들기 전에는 사이트를 그대로 공개)
export async function authState() {
  const R = repoInfo();
  if (!R) return { configured: false, acct: null };
  if (!session) await resume(R);
  if (session?.token) return { configured: true, acct: session.acct };
  let doc = null;
  try { doc = await loadAuth(R); } catch {}
  return { configured: !!doc?.master, acct: null };
}
export const can = (p) => !session || session.acct.role === "master" || !!session.acct.perms?.[p];
export const hidden = (p) => !!session && session.acct.role !== "master" && !session.acct.perms?.[p] && !!session.acct.perms?.["hide_" + p];
export const currentAcct = () => session?.acct || null;
export async function signOut() { await logout(); location.reload(); }
// 전체 화면 로그인 (인트로)
export function loginGate(el, onDone) {
  const R = repoInfo();
  el.innerHTML = "";
  const wrap = h(`<div class="gate"><div class="gate-intro"><div class="auth-logo big">N</div><h1>${esc(CFG.siteName || "뉴스 인사이트")}</h1><p>네이버 랭킹·발행 통계와 키워드·기자 인사이트<br>계정이 있는 분만 볼 수 있습니다</p></div><div id="gateBox"></div></div>`);
  el.append(wrap);
  loginView($("#gateBox", wrap), R, null, "", onDone);
}

// 검색 키워드 관심 분야 저장 → 검색 키워드 수집 바로 실행
export async function saveSeedGroups(groups) {
  if (!session?.token) throw new Error("관리자 로그인이 필요합니다.");
  if (session.acct.role !== "master" && !session.acct.perms.collect) throw new Error("데이터 수집 권한이 필요합니다.");
  const seeds = [...new Set(Object.values(groups).flat())];
  await updateJSON("collector/config.json", () => ({}), (d) => { d.search_seed_groups = groups; d.search_seeds = seeds; }, `관심 분야 키워드 변경 — ${who()}`);
  logAct("관심 분야 키워드 변경", `${Object.keys(groups).length}개 분야 · 키워드 ${seeds.length}개`);
  const { owner, repo, branch } = session.R;
  try { await gh(`/repos/${owner}/${repo}/actions/workflows/search.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: branch, inputs: { force: "yes" } }) }); } catch (e) { console.warn(e); }
}
