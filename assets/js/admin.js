// 관리자 백단 — GitHub 저장소를 데이터베이스로 사용
// 관리자 3~4명은 저장소 협업자(Collaborator)로 초대하고, 각자 개인 토큰으로 로그인합니다.
import { esc, h, $, $$, markdown, toast, kstToday, dotDate, kstDateTime, relTime } from "./util.js";
import { TYPES, isActive } from "./board.js";
import { meta } from "./data.js";

const API = "https://api.github.com";
const CFG = window.SITE_CONFIG || {};
const TOKEN_KEY = "nk_admin_token";

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

// ── 토큰/세션 ─────────────────────────
function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function setToken(t, remember) {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
    if (remember) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch {}
}

async function gh(path, opts = {}, token = getToken()) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
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

let session = null; // { user, repo }

async function login(token) {
  const R = repoInfo();
  if (!R) throw new Error("저장소 정보를 알 수 없습니다. assets/js/config.js 의 repo 값을 '소유자/저장소명'으로 설정해 주세요.");
  const user = await gh("/user", {}, token);
  const repo = await gh(`/repos/${R.owner}/${R.repo}`, {}, token);
  if (!repo.permissions?.push) throw new Error(`@${user.login} 계정은 ${R.owner}/${R.repo} 저장소에 쓰기 권한이 없습니다. 저장소 Settings → Collaborators에서 초대받아야 합니다.`);
  if (CFG.admins?.length && !CFG.admins.map((x) => x.toLowerCase()).includes(user.login.toLowerCase()))
    throw new Error(`@${user.login} 은(는) 관리자 목록(config.js admins)에 없습니다.`);
  session = { user, R };
  return session;
}

async function getFile(path) {
  const { owner, repo, branch } = session.R;
  try {
    const f = await gh(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`);
    return { text: b64decode(f.content), sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { text: null, sha: null };
    throw e;
  }
}

async function putFile(path, contentB64, sha, message) {
  const { owner, repo, branch } = session.R;
  return gh(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: contentB64, branch, ...(sha ? { sha } : {}) }),
  });
}

// 동시에 여러 관리자가 저장해도 덮어쓰지 않도록: 최신본을 받아 변경을 다시 적용 후 저장 (충돌 시 재시도)
async function updateBoard(mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await getFile("data/board.json");
    const doc = text ? JSON.parse(text) : { posts: [] };
    doc.posts ||= [];
    mutate(doc);
    doc.updated_at = new Date().toISOString();
    try {
      await putFile("data/board.json", b64encode(JSON.stringify(doc, null, 1)), sha, `${message} (@${session.user.login})`);
      return doc;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
      throw e;
    }
  }
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
  await putFile(name, b64, null, `이미지 업로드 ${name} (@${session.user.login})`);
  return { path: name, dataUrl };
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#18335c");

// ═══════════════════════════════════════════════════════
export async function adminPage(el, ctx) {
  el.append(h(`<div class="page-head"><div><h1>관리자</h1><p>공지·배너·게시글을 등록하고 데이터 수집을 실행합니다. 저장한 내용은 GitHub 저장소에 기록되며 1~2분 후 모든 사용자에게 반영됩니다.</p></div></div>`));
  const body = h(`<div class="view"></div>`);
  el.append(body);

  const R = repoInfo();
  const tok = getToken();
  if (tok && !session) {
    body.innerHTML = '<div class="card"><div class="loading">로그인 확인 중…</div></div>';
    try { await login(tok); } catch (e) { clearToken(); session = null; }
  }
  if (!session) return loginView(body, R, ctx);
  return dashboardView(body, ctx);
}

function loginView(body, R, ctx) {
  body.innerHTML = "";
  const card = h(`<div class="card admin-login">
    <div class="card-head"><div><h3>관리자 로그인</h3><div class="sub">저장소: ${R ? `<span class="code">${esc(R.owner)}/${esc(R.repo)}</span>` : '<span class="err-box" style="display:inline-block;padding:2px 6px">config.js에 repo를 설정해 주세요</span>'}</div></div></div>
    <ol>
      <li><b>저장소가 조직(Organization) 소유일 때</b>: <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained 토큰</a> → Resource owner에 조직 선택 → 이 저장소만 선택 → Permissions <b>Contents: Read and write</b>, <b>Actions: Read and write</b></li>
      <li><b>개인 계정 저장소에 협업자로 초대된 경우</b>: <a href="https://github.com/settings/tokens/new?scopes=public_repo,workflow&description=news-insight" target="_blank" rel="noopener">Classic 토큰</a> → <b>public_repo</b>(비공개 저장소면 repo), <b>workflow</b> 체크</li>
      <li>만든 토큰을 아래에 붙여넣기 (토큰은 이 브라우저에만 저장되고 GitHub 외 다른 곳으로 전송되지 않습니다)</li>
    </ol>
    <div class="form-grid" style="margin-top:12px">
      <label for="tk">토큰</label><input class="input" id="tk" type="password" placeholder="github_pat_… 또는 ghp_…" autocomplete="off">
      <span></span><label class="check"><input type="checkbox" id="rm"> 이 브라우저에 로그인 유지 (공용 PC에서는 체크하지 마세요)</label>
      <span></span><div class="row"><button class="btn primary" id="go">로그인</button><span id="msg"></span></div>
    </div></div>`);
  body.append(card);
  const go = async () => {
    const t = $("#tk", card).value.trim();
    if (!t) return;
    $("#go", card).disabled = true;
    $("#msg", card).innerHTML = '<span class="status-line">확인 중…</span>';
    try {
      await login(t);
      setToken(t, $("#rm", card).checked);
      toast(`@${session.user.login} 님 환영합니다`);
      dashboardView(body, ctx);
    } catch (e) {
      $("#msg", card).innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
      $("#go", card).disabled = false;
    }
  };
  $("#go", card).addEventListener("click", go);
  $("#tk", card).addEventListener("keydown", (e) => e.key === "Enter" && go());
}

async function dashboardView(body, ctx) {
  body.innerHTML = "";
  const { user, R } = session;
  const top = h(`<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <img src="${esc(user.avatar_url)}" alt="" width="34" height="34" style="border-radius:50%">
    <div><b>${esc(user.name || user.login)}</b> <span class="status-line">@${esc(user.login)} · ${esc(R.owner)}/${esc(R.repo)} (${esc(R.branch)})</span></div>
    <div class="seg" id="atab" style="margin-left:auto"><button data-t="posts" class="on">게시글·배너·공지</button><button data-t="collect">데이터 수집</button></div>
    <button class="btn sm" id="logout">로그아웃</button></div>`);
  body.append(top);
  const pane = h(`<div class="view"></div>`);
  body.append(pane);
  $("#logout", top).addEventListener("click", () => { clearToken(); session = null; toast("로그아웃했습니다"); loginView(body, R, ctx); });
  const show = (t) => {
    $$("#atab button", top).forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    pane.innerHTML = "";
    t === "posts" ? postsView(pane, ctx) : collectView(pane);
  };
  $$("#atab button", top).forEach((b) => b.addEventListener("click", () => show(b.dataset.t)));
  show("posts");
}

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
      x.author ||= session.user.login;
      x.author_name ||= session.user.name || session.user.login;
      x.editor = session.user.login;
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
  const card = h(`<div class="card"><div class="card-head"><div><h3>수집 실행</h3><div class="sub">GitHub Actions에서 수집기가 실행됩니다 (자동 수집은 2시간마다). 과거 기간을 채울 때도 여기서 실행하세요.</div></div></div>
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
  if (M.last_run?.errors?.length) runs.append(h(`<div class="err-box" style="margin-top:12px"><b>최근 수집 경고</b><br>${M.last_run.errors.map(esc).join("<br>")}</div>`));
}
