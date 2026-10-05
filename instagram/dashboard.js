const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createDashboard(options = {}) {
  const apiVersion = options.apiVersion || "v26.0";
  const publicBaseUrl = String(options.publicBaseUrl || "").replace(/\/+$/, "");
  const stateDir = options.stateDir || "/data/instagram";
  const connectionFile = path.join(stateDir, "connection.json");
  const getAutomationState = options.getAutomationState || (() => ({ reviews: [], actions: [], processed: {} }));
  const getReplyMode = options.getReplyMode || (() => "review");

  const adminPassword = process.env.INSTAGRAM_ADMIN_PASSWORD || "";
  const sessionSecret = process.env.INSTAGRAM_SESSION_SECRET || "";
  const tokenKeyRaw = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY || "";
  const envAppId = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || "";
  const envAppSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || "";
  const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || "";

  fs.mkdirSync(stateDir, { recursive: true });

  function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ""));
    const bb = Buffer.from(String(b || ""));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  }

  function htmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function b64urlEncode(value) {
    return Buffer.from(value).toString("base64url");
  }

  function b64urlDecode(value) {
    return Buffer.from(String(value || ""), "base64url").toString("utf8");
  }

  function tokenKey() {
    if (!tokenKeyRaw) return null;
    try {
      const decoded = Buffer.from(tokenKeyRaw, "base64");
      if (decoded.length === 32) return decoded;
    } catch (_) {}
    return crypto.createHash("sha256").update(tokenKeyRaw).digest();
  }

  function encryptSecret(value) {
    if (!value) return "";
    const key = tokenKey();
    if (!key) throw new Error("INSTAGRAM_TOKEN_ENCRYPTION_KEY_missing");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  function decryptSecret(value) {
    if (!value) return "";
    const key = tokenKey();
    if (!key) return "";
    try {
      const parts = String(value).split(".");
      if (parts.length !== 3) return "";
      const iv = Buffer.from(parts[0], "base64url");
      const tag = Buffer.from(parts[1], "base64url");
      const encrypted = Buffer.from(parts[2], "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch (_) {
      return "";
    }
  }

  function loadConnectionState() {
    try {
      const value = JSON.parse(fs.readFileSync(connectionFile, "utf8"));
      if (!value.meta) value.meta = {};
      if (!value.oauth) value.oauth = {};
      return value;
    } catch (_) {
      return { version: 1, meta: {}, oauth: {} };
    }
  }

  function saveConnectionState(state) {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = connectionFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, connectionFile);
    try { fs.chmodSync(connectionFile, 0o600); } catch (_) {}
  }

  function appCredentials() {
    const state = loadConnectionState();
    return {
      appId: envAppId || String(state.meta.app_id || ""),
      appSecret: envAppSecret || decryptSecret(state.meta.app_secret_enc || ""),
      source: envAppId && envAppSecret ? "environment" : (state.meta.app_id && state.meta.app_secret_enc ? "dashboard" : "missing")
    };
  }

  function getConnection() {
    const state = loadConnectionState();
    const oauth = state.oauth || {};
    const accessToken = decryptSecret(oauth.access_token_enc || "") || process.env.INSTAGRAM_ACCESS_TOKEN || "";
    const accountId = String(oauth.user_id || process.env.INSTAGRAM_ACCOUNT_ID || "");
    return {
      connected: Boolean(accessToken && accountId),
      accessToken,
      accountId,
      username: String(oauth.username || ""),
      name: String(oauth.name || ""),
      connectedAt: String(oauth.connected_at || ""),
      expiresAt: String(oauth.expires_at || ""),
      subscriptionOk: oauth.subscription_ok === true,
      subscriptionError: String(oauth.subscription_error || "")
    };
  }

  function getAppSecret() {
    return appCredentials().appSecret || "";
  }

  function parseCookies(req) {
    const result = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return result;
  }

  function signSession(exp) {
    const payload = "admin:" + String(exp);
    return b64urlEncode(payload) + "." + crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  }

  function validSession(req) {
    if (!adminPassword || !sessionSecret) return false;
    const cookie = parseCookies(req).ig_session || "";
    const parts = cookie.split(".");
    if (parts.length !== 2) return false;
    let payload = "";
    try { payload = b64urlDecode(parts[0]); } catch (_) { return false; }
    const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
    if (!safeEqual(expected, parts[1])) return false;
    const match = payload.match(/^admin:(\d+)$/);
    return Boolean(match && Number(match[1]) > Date.now());
  }

  function setSession(res) {
    const exp = Date.now() + 14 * 24 * 60 * 60 * 1000;
    res.setHeader("set-cookie", "ig_session=" + encodeURIComponent(signSession(exp)) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600");
  }

  function clearSession(res) {
    res.setHeader("set-cookie", "ig_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  }

  function signState(payload) {
    const body = b64urlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
    return body + "." + sig;
  }

  function verifyState(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 2 || !sessionSecret) return null;
    const expected = crypto.createHmac("sha256", sessionSecret).update(parts[0]).digest("base64url");
    if (!safeEqual(expected, parts[1])) return null;
    try {
      const payload = JSON.parse(b64urlDecode(parts[0]));
      if (!payload.exp || Number(payload.exp) < Date.now()) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  async function readBody(req, limit = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    return new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error("request_too_large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function readForm(req) {
    return new URLSearchParams(await readBody(req));
  }

  function redirect(res, location) {
    res.statusCode = 302;
    res.setHeader("location", location);
    res.end();
  }

  function sendHtml(res, body, status = 200) {
    res.statusCode = status;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self' https://www.instagram.com; frame-ancestors 'none'; base-uri 'none'");
    res.end(body);
  }

  function baseCss() {
    return "<style>" +
      "*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Pretendard,Arial,sans-serif;background:#f6f7fb;color:#171821}" +
      ".shell{max-width:820px;margin:0 auto;padding:22px 16px 54px}.hero{background:linear-gradient(135deg,#fff 0%,#fff6fb 45%,#f3efff 100%);border:1px solid #ececf3;border-radius:28px;padding:24px;box-shadow:0 12px 35px rgba(24,24,40,.07)}" +
      ".eyebrow{font-size:13px;font-weight:800;letter-spacing:.06em;color:#7c3aed;text-transform:uppercase}.title{font-size:30px;line-height:1.15;margin:8px 0 8px;font-weight:850}.muted{color:#707386;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}" +
      ".card{background:#fff;border:1px solid #e9eaf0;border-radius:22px;padding:18px;box-shadow:0 6px 22px rgba(20,20,38,.04)}.card h3{font-size:16px;margin:0 0 10px}.status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:800}.ok{background:#eaf8ef;color:#15743a}.warn{background:#fff5df;color:#8a5a00}.off{background:#f0f1f5;color:#646878}" +
      ".button{display:inline-flex;justify-content:center;align-items:center;text-decoration:none;border:0;border-radius:14px;padding:13px 16px;font-weight:800;font-size:15px;cursor:pointer}.primary{color:#fff;background:linear-gradient(135deg,#8b5cf6,#ec4899)}.secondary{background:#f1efff;color:#5b38bd}.danger{background:#fff0f0;color:#b42318}.full{width:100%}" +
      ".kv{display:grid;grid-template-columns:120px 1fr;gap:7px;font-size:13px;margin:8px 0}.kv b{color:#30313d}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f5f8;border-radius:10px;padding:10px;word-break:break-all;font-size:12px}.section{margin-top:16px}.field{width:100%;border:1px solid #dfe1e8;border-radius:13px;padding:13px 14px;font-size:16px;background:#fff;margin-top:7px}.label{font-size:13px;font-weight:800;margin-top:12px}.row{display:flex;gap:10px;flex-wrap:wrap}.pill{padding:5px 9px;border-radius:999px;background:#f2f3f7;font-size:12px}.successbox{background:#effaf3;border:1px solid #ccebd7;border-radius:15px;padding:13px;color:#1d6238}.errorbox{background:#fff1f0;border:1px solid #ffd1cd;border-radius:15px;padding:13px;color:#a52920}.notice{background:#f4f1ff;border:1px solid #ded4ff;border-radius:15px;padding:13px;color:#59439b}.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.tiny{font-size:12px;color:#858899}.stats{font-size:26px;font-weight:850;margin-top:5px}" +
      "@media(max-width:640px){.grid{grid-template-columns:1fr}.title{font-size:27px}.hero{padding:20px}.kv{grid-template-columns:1fr}.shell{padding-top:12px}}" +
      "</style>";
  }

  function loginPage(errorText = "") {
    return "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<title>Instagram 자동화</title>" + baseCss() + "</head><body><main class='shell'>" +
      "<section class='hero' style='margin-top:9vh'><div class='eyebrow'>Instagram Automation</div><h1 class='title'>관리자 로그인</h1>" +
      "<p class='muted'>Instagram 계정 연결과 자동화 설정을 안전하게 관리합니다.</p>" +
      (errorText ? "<div class='errorbox'>" + htmlEscape(errorText) + "</div>" : "") +
      "<form method='post' action='/ui/login'><div class='label'>관리 비밀번호</div><input class='field' type='password' name='password' autocomplete='current-password' placeholder='비밀번호 입력' required>" +
      "<button class='button primary full' style='margin-top:14px' type='submit'>로그인</button></form>" +
      "<p class='tiny' style='margin-top:14px'>비밀번호는 브라우저에 표시되지 않으며 서버의 환경변수와 비교합니다.</p></section></main></body></html>";
  }

  function dashboardPage(message = "", isError = false) {
    const creds = appCredentials();
    const connection = getConnection();
    const automation = getAutomationState() || {};
    const reviews = Array.isArray(automation.reviews) ? automation.reviews : [];
    const actions = Array.isArray(automation.actions) ? automation.actions : [];
    const pending = reviews.filter((r) => r && r.status === "pending").length;
    const oauthReady = Boolean(creds.appId && creds.appSecret && sessionSecret && tokenKey());
    const redirectUri = publicBaseUrl + "/instagram/oauth/callback";
    const webhookUrl = publicBaseUrl + "/instagram/webhook";
    const tokenDays = connection.expiresAt ? Math.max(0, Math.ceil((new Date(connection.expiresAt).getTime() - Date.now()) / 86400000)) : null;

    return "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Instagram 자동화</title>" +
      baseCss() + "</head><body><main class='shell'><div class='topbar'><div><b>Instagram 자동화</b><div class='tiny'>Railway · Meta 공식 API</div></div><form method='post' action='/ui/logout'><button class='button secondary' type='submit'>로그아웃</button></form></div>" +
      "<section class='hero'><div class='eyebrow'>Account Connection</div><h1 class='title'>" + (connection.connected ? "@" + htmlEscape(connection.username || "연결된 계정") : "Instagram 계정을 연결하세요") + "</h1>" +
      "<p class='muted'>" + (connection.connected ? "계정 연결이 완료되었습니다. 게시물 업로드와 댓글 자동화를 이 계정으로 실행합니다." : "Instagram Business 또는 Creator 계정을 공식 로그인으로 연결합니다. 별도 유료 연동 서비스는 사용하지 않습니다.") + "</p>" +
      (message ? "<div class='" + (isError ? "errorbox" : "successbox") + "'>" + htmlEscape(message) + "</div>" : "") +
      "<div class='row' style='margin-top:16px'>" +
      (connection.connected
        ? "<a class='button primary' href='/instagram/oauth/start'>다른 계정으로 다시 연결</a><form method='post' action='/instagram/oauth/disconnect'><button class='button danger' type='submit'>연결 해제</button></form>"
        : (oauthReady ? "<a class='button primary' href='/instagram/oauth/start'>Instagram 계정 연결</a>" : "<span class='button' style='background:#eceef3;color:#9699a7'>Instagram 계정 연결</span>")) +
      "</div></section>" +

      "<section class='grid'>" +
      "<div class='card'><h3>연결 상태</h3><span class='status " + (connection.connected ? "ok" : "off") + "'>" + (connection.connected ? "● 연결됨" : "● 미연결") + "</span>" +
      (connection.connected ? "<div class='kv'><b>계정</b><span>@" + htmlEscape(connection.username || "-") + "</span><b>이름</b><span>" + htmlEscape(connection.name || "-") + "</span><b>토큰</b><span>" + (tokenDays == null ? "장기 토큰" : tokenDays + "일 남음") + "</span><b>댓글 구독</b><span>" + (connection.subscriptionOk ? "정상" : "확인 필요") + "</span></div>" : "<p class='muted'>아직 연결된 Instagram 계정이 없습니다.</p>") + "</div>" +
      "<div class='card'><h3>자동 답글 모드</h3><div class='stats'>" + (getReplyMode() === "safe_auto" ? "ON" : "검토") + "</div><p class='muted'>" + (getReplyMode() === "safe_auto" ? "허용된 저위험 댓글만 자동 답글합니다." : "현재는 댓글을 검토대기에 쌓고 자동 답글하지 않습니다.") + "</p></div>" +
      "<div class='card'><h3>검토대기 댓글</h3><div class='stats'>" + pending + "</div><p class='muted'>세무 질문과 애매한 댓글은 자동 답변하지 않고 보류합니다.</p></div>" +
      "<div class='card'><h3>최근 작업 기록</h3><div class='stats'>" + actions.length + "</div><p class='muted'>최근 게시·답글·실패 기록을 서버에 보관합니다.</p></div>" +
      "</section>" +

      "<section class='card section'><h3>① Meta 앱 연결 설정</h3>" +
      (creds.appId && creds.appSecret
        ? "<div class='successbox'>Instagram App ID와 App Secret이 등록되어 있습니다. 이제 아래 OAuth 주소를 Meta의 Valid OAuth Redirect URI에 등록한 뒤 계정 연결 버튼을 누르시면 됩니다.</div>"
        : "<div class='notice'>최초 한 번만 Meta for Developers에서 Instagram 앱을 만든 뒤 App ID와 App Secret을 입력하면 됩니다. 입력한 Secret은 AES-256-GCM으로 암호화해 이 서버의 영구 저장소에 보관합니다.</div>") +
      "<form method='post' action='/ui/meta-config'>" +
      "<div class='label'>Instagram App ID</div><input class='field' name='app_id' value='" + htmlEscape(creds.appId) + "' placeholder='예: 123456789012345' required>" +
      "<div class='label'>Instagram App Secret</div><input class='field' type='password' name='app_secret' placeholder='" + (creds.appSecret ? "등록됨 · 변경할 때만 입력" : "Instagram App Secret 입력") + "' " + (creds.appSecret ? "" : "required") + ">" +
      "<button class='button secondary' style='margin-top:12px' type='submit'>Meta 앱 정보 저장</button></form>" +
      "<div class='label'>Meta에 등록할 OAuth Redirect URI</div><div class='code'>" + htmlEscape(redirectUri) + "</div>" +
      "<div class='label'>Webhook Callback URL</div><div class='code'>" + htmlEscape(webhookUrl) + "</div>" +
      "<div class='label'>Webhook Verify Token</div><div class='code'>" + htmlEscape(verifyToken || "서버 설정 필요") + "</div>" +
      "<p class='tiny'>필요 권한: instagram_business_basic · instagram_business_content_publish · instagram_business_manage_comments</p></section>" +

      "<section class='card section'><h3>② 비용 최소화 설정</h3><div class='row'><span class='pill'>Meta API 사용료 0원</span><span class='pill'>외부 자동화 SaaS 없음</span><span class='pill'>별도 DB 없음</span><span class='pill'>AI API 미사용</span></div>" +
      "<p class='muted'>현재 댓글 분류와 기본 답글은 서버 내부 규칙으로 처리합니다. ChatGPT API는 연결하지 않아 별도 AI 호출비가 발생하지 않습니다.</p></section>" +

      "<section class='card section'><h3>③ 현재 안전장치</h3><p class='muted'>OAuth state 서명검증, 토큰 AES-256-GCM 암호화, Webhook 서명검증, 댓글 중복방지, 실패 재시도를 적용했습니다. 자동 답글은 기본적으로 <b>검토 모드</b>입니다.</p></section>" +
      "</main></body></html>";
  }

  async function exchangeCodeForShortToken(code, appId, appSecret, redirectUri) {
    const form = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: String(code || "").replace(/#_$/, "")
    });
    const response = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body }; }
    if (!response.ok || !data.access_token) throw new Error("Instagram 단기 토큰 발급 실패: " + JSON.stringify(data).slice(0, 500));
    return data;
  }

  async function exchangeLongToken(shortToken, appSecret) {
    const url = new URL("https://graph.instagram.com/" + apiVersion + "/access_token");
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("access_token", shortToken);
    const response = await fetch(url);
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body }; }
    if (!response.ok || !data.access_token) throw new Error("Instagram 장기 토큰 교환 실패: " + JSON.stringify(data).slice(0, 500));
    return data;
  }

  async function fetchProfile(token) {
    const url = new URL("https://graph.instagram.com/" + apiVersion + "/me");
    url.searchParams.set("fields", "user_id,username,name");
    url.searchParams.set("access_token", token);
    const response = await fetch(url);
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body }; }
    if (!response.ok) throw new Error("Instagram 프로필 확인 실패: " + JSON.stringify(data).slice(0, 500));
    return data;
  }

  async function subscribeComments(token, userId) {
    if (!userId) throw new Error("Instagram 계정 ID가 없어 댓글 구독을 설정할 수 없습니다.");
    const url = new URL("https://graph.instagram.com/" + apiVersion + "/" + encodeURIComponent(userId) + "/subscribed_apps");
    url.searchParams.set("subscribed_fields", "comments");
    url.searchParams.set("access_token", token);
    const response = await fetch(url, { method: "POST" });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body }; }
    if (!response.ok || data.success !== true) throw new Error("댓글 Webhook 계정 구독 실패: " + JSON.stringify(data).slice(0, 500));
    return data;
  }

  async function refreshLongToken(token) {
    const url = new URL("https://graph.instagram.com/" + apiVersion + "/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", token);
    const response = await fetch(url);
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { data = { raw: body }; }
    if (!response.ok || !data.access_token) throw new Error("토큰 갱신 실패: " + JSON.stringify(data).slice(0, 500));
    return data;
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/") {
      if (!validSession(req)) {
        sendHtml(res, loginPage(url.searchParams.get("login_error") ? "비밀번호를 확인해주세요." : ""));
        return true;
      }
      const message = url.searchParams.get("message") || (url.searchParams.get("connected") ? "Instagram 계정 연결이 완료되었습니다." : "");
      const isError = url.searchParams.get("error") === "1";
      sendHtml(res, dashboardPage(message, isError));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/ui/login") {
      const form = await readForm(req);
      if (!adminPassword || !safeEqual(form.get("password") || "", adminPassword)) {
        redirect(res, "/?login_error=1");
        return true;
      }
      setSession(res);
      redirect(res, "/");
      return true;
    }

    if (req.method === "POST" && url.pathname === "/ui/logout") {
      clearSession(res);
      redirect(res, "/");
      return true;
    }

    if (req.method === "POST" && url.pathname === "/ui/meta-config") {
      if (!validSession(req)) {
        redirect(res, "/");
        return true;
      }
      const form = await readForm(req);
      const appId = String(form.get("app_id") || "").trim();
      const appSecret = String(form.get("app_secret") || "").trim();
      if (!/^\d{6,30}$/.test(appId)) {
        redirect(res, "/?error=1&message=" + encodeURIComponent("Instagram App ID 형식을 확인해주세요."));
        return true;
      }
      const state = loadConnectionState();
      state.meta.app_id = appId;
      if (appSecret) state.meta.app_secret_enc = encryptSecret(appSecret);
      if (!state.meta.app_secret_enc && !envAppSecret) {
        redirect(res, "/?error=1&message=" + encodeURIComponent("Instagram App Secret을 입력해주세요."));
        return true;
      }
      state.meta.updated_at = new Date().toISOString();
      saveConnectionState(state);
      redirect(res, "/?message=" + encodeURIComponent("Meta 앱 정보를 저장했습니다."));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/instagram/oauth/start") {
      if (!validSession(req)) {
        redirect(res, "/");
        return true;
      }
      const creds = appCredentials();
      if (!creds.appId || !creds.appSecret || !publicBaseUrl || !sessionSecret) {
        redirect(res, "/?error=1&message=" + encodeURIComponent("먼저 Meta 앱 정보를 등록해주세요."));
        return true;
      }
      const redirectUri = publicBaseUrl + "/instagram/oauth/callback";
      const state = signState({ exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomBytes(12).toString("hex") });
      const auth = new URL("https://www.instagram.com/oauth/authorize");
      auth.searchParams.set("client_id", creds.appId);
      auth.searchParams.set("redirect_uri", redirectUri);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments");
      auth.searchParams.set("state", state);
      auth.searchParams.set("enable_fb_login", "0");
      auth.searchParams.set("force_authentication", "1");
      redirect(res, auth.toString());
      return true;
    }

    if (req.method === "GET" && url.pathname === "/instagram/oauth/callback") {
      const statePayload = verifyState(url.searchParams.get("state") || "");
      if (!statePayload) {
        redirect(res, "/?error=1&message=" + encodeURIComponent("OAuth 보안 검증에 실패했습니다. 다시 연결해주세요."));
        return true;
      }
      if (url.searchParams.get("error")) {
        redirect(res, "/?error=1&message=" + encodeURIComponent("Instagram 연결이 취소되었거나 권한이 허용되지 않았습니다."));
        return true;
      }
      const code = url.searchParams.get("code") || "";
      const creds = appCredentials();
      try {
        const redirectUri = publicBaseUrl + "/instagram/oauth/callback";
        const shortToken = await exchangeCodeForShortToken(code, creds.appId, creds.appSecret, redirectUri);
        const longToken = await exchangeLongToken(shortToken.access_token, creds.appSecret);
        const profile = await fetchProfile(longToken.access_token);
        const userId = String(profile.user_id || profile.id || shortToken.user_id || "");
        if (!userId) throw new Error("Instagram 계정 ID를 확인하지 못했습니다.");

        const state = loadConnectionState();
        state.oauth = {
          access_token_enc: encryptSecret(longToken.access_token),
          user_id: userId,
          username: String(profile.username || ""),
          name: String(profile.name || ""),
          connected_at: new Date().toISOString(),
          expires_at: longToken.expires_in ? new Date(Date.now() + Number(longToken.expires_in) * 1000).toISOString() : "",
          subscription_ok: false,
          subscription_error: ""
        };
        saveConnectionState(state);

        try {
          await subscribeComments(longToken.access_token, userId);
          const updated = loadConnectionState();
          updated.oauth.subscription_ok = true;
          updated.oauth.subscription_error = "";
          updated.oauth.subscription_updated_at = new Date().toISOString();
          saveConnectionState(updated);
        } catch (subscriptionError) {
          const updated = loadConnectionState();
          updated.oauth.subscription_ok = false;
          updated.oauth.subscription_error = subscriptionError.message;
          saveConnectionState(updated);
        }

        setSession(res);
        redirect(res, "/?connected=1");
      } catch (error) {
        redirect(res, "/?error=1&message=" + encodeURIComponent(error.message));
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/instagram/oauth/refresh") {
      if (!validSession(req)) {
        redirect(res, "/");
        return true;
      }
      try {
        const connection = getConnection();
        if (!connection.accessToken) throw new Error("연결된 Instagram 계정이 없습니다.");
        const refreshed = await refreshLongToken(connection.accessToken);
        const state = loadConnectionState();
        state.oauth.access_token_enc = encryptSecret(refreshed.access_token);
        state.oauth.expires_at = refreshed.expires_in ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString() : state.oauth.expires_at;
        state.oauth.refreshed_at = new Date().toISOString();
        saveConnectionState(state);
        redirect(res, "/?message=" + encodeURIComponent("Instagram 장기 토큰을 갱신했습니다."));
      } catch (error) {
        redirect(res, "/?error=1&message=" + encodeURIComponent(error.message));
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/instagram/oauth/disconnect") {
      if (!validSession(req)) {
        redirect(res, "/");
        return true;
      }
      const state = loadConnectionState();
      state.oauth = {};
      saveConnectionState(state);
      redirect(res, "/?message=" + encodeURIComponent("Instagram 계정 연결을 해제했습니다."));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/privacy") {
      sendHtml(res, "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>개인정보 처리 안내</title>" + baseCss() + "</head><body><main class='shell'><section class='card'><h1>개인정보 처리 안내</h1><p class='muted'>이 도구는 연결된 Instagram 전문 계정의 게시 및 댓글 자동화를 위해 Meta가 제공한 접근 토큰과 최소한의 계정 식별정보를 저장합니다. 토큰은 서버에서 암호화하여 저장하며 외부 광고·판매 목적으로 사용하지 않습니다.</p></section></main></body></html>");
      return true;
    }

    if (req.method === "POST" && (url.pathname === "/data-deletion" || url.pathname === "/deauthorize")) {
      const state = loadConnectionState();
      state.oauth = {};
      saveConnectionState(state);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, status: "deleted" }));
      return true;
    }

    return false;
  }

  return {
    handle,
    getConnection,
    getAppSecret,
    getAppCredentials: appCredentials,
    dashboardStatus() {
      const creds = appCredentials();
      const connection = getConnection();
      return {
        appConfigured: Boolean(creds.appId && creds.appSecret),
        connected: connection.connected,
        accountId: connection.accountId,
        username: connection.username,
        name: connection.name,
        expiresAt: connection.expiresAt,
        subscriptionOk: connection.subscriptionOk
      };
    }
  };
}

module.exports = { createDashboard };
