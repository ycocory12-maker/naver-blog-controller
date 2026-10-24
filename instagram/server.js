const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDashboard } = require("./dashboard");

const PORT = Number(process.env.PORT || 3000);
const API_VERSION = process.env.INSTAGRAM_API_VERSION || "v26.0";
const GRAPH_BASE = (process.env.INSTAGRAM_GRAPH_BASE_URL || "https://graph.instagram.com").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || "";
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || "";
const VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || "";
const ADMIN_TOKEN = process.env.INSTAGRAM_ADMIN_TOKEN || "";
const REPLY_MODE = String(process.env.INSTAGRAM_REPLY_MODE || "review").toLowerCase();
const AUTO_CATEGORIES = new Set(
  String(process.env.INSTAGRAM_AUTO_REPLY_CATEGORIES || "thanks,consultation")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
);
const STATE_DIR = process.env.INSTAGRAM_STATE_DIR || "/data/instagram";
const STATE_FILE = path.join(STATE_DIR, "state.json");
const MEDIA_DIR = path.join(STATE_DIR, "media");
const MEDIA_SECRET = process.env.INSTAGRAM_MEDIA_SIGNING_SECRET || ADMIN_TOKEN || APP_SECRET || "";
const PUBLIC_BASE_URL = (
  process.env.INSTAGRAM_PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "")
).replace(/\/+$/, "");
const REVIEW_LIMIT = Math.max(20, Math.min(Number(process.env.INSTAGRAM_REVIEW_LIMIT || 500), 5000));
const MAX_BODY = 12 * 1024 * 1024;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function log(event, data) {
  const row = { ts: new Date().toISOString(), event, data: data || {} };
  console.log(JSON.stringify(row));
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function text(res, status, body, type) {
  res.statusCode = status;
  res.setHeader("content-type", type || "text/plain; charset=utf-8");
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > (limit || MAX_BODY)) {
        reject(new Error("request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8") || "{}");
  } catch (_) {
    throw new Error("invalid_json");
  }
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyWebhookSignature(rawBody, header) {
  const secret = runtimeAppSecret();
  if (!secret) return { ok: false, reason: "INSTAGRAM_APP_SECRET_missing" };
  if (!header || !String(header).startsWith("sha256=")) return { ok: false, reason: "signature_missing" };
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return { ok: safeEqual(expected, header), reason: "signature_mismatch" };
}

function adminAuthorized(req, url) {
  if (!ADMIN_TOKEN) return false;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const header = String(req.headers["x-instagram-admin-token"] || "");
  const query = url ? String(url.searchParams.get("token") || "") : "";
  return safeEqual(bearer, ADMIN_TOKEN) || safeEqual(header, ADMIN_TOKEN) || safeEqual(query, ADMIN_TOKEN);
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!state.processed) state.processed = {};
    if (!Array.isArray(state.reviews)) state.reviews = [];
    if (!Array.isArray(state.actions)) state.actions = [];
    return state;
  } catch (_) {
    return { version: 1, processed: {}, reviews: [], actions: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

const dashboard = createDashboard({
  apiVersion: API_VERSION,
  publicBaseUrl: PUBLIC_BASE_URL,
  stateDir: STATE_DIR,
  getAutomationState: loadState,
  getReplyMode: () => REPLY_MODE
});

function runtimeConnection() {
  return dashboard.getConnection();
}

function runtimeAccessToken() {
  return runtimeConnection().accessToken || ACCESS_TOKEN || "";
}

function runtimeAccountId() {
  return runtimeConnection().accountId || IG_ACCOUNT_ID || "";
}

function runtimeAppSecret() {
  return dashboard.getAppSecret() || APP_SECRET || "";
}

function rememberProcessed(commentId, result) {
  const state = loadState();
  state.processed[String(commentId)] = {
    at: new Date().toISOString(),
    result: result || {}
  };
  const ids = Object.keys(state.processed);
  if (ids.length > 5000) {
    ids.sort((a, b) => String(state.processed[a].at).localeCompare(String(state.processed[b].at)));
    for (const id of ids.slice(0, ids.length - 4000)) delete state.processed[id];
  }
  saveState(state);
}

function alreadyProcessed(commentId) {
  const state = loadState();
  return Boolean(state.processed[String(commentId)]);
}

function addReview(item) {
  const state = loadState();
  state.reviews.unshift(item);
  state.reviews = state.reviews.slice(0, REVIEW_LIMIT);
  saveState(state);
}

function addAction(item) {
  const state = loadState();
  state.actions.unshift(item);
  state.actions = state.actions.slice(0, 1000);
  saveState(state);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function classifyComment(commentText) {
  const t = cleanText(commentText);
  const lower = t.toLowerCase();

  if (!t) return { category: "empty", confidence: 1, reason: "empty" };
  if (/(https?:\/\/|www\.|t\.me\/|wa\.me\/)/i.test(t) && /(dm|follow|promo|promotion|crypto|investment|투자|홍보|팔로우)/i.test(t)) {
    return { category: "spam", confidence: 0.95, reason: "link_plus_promo_pattern" };
  }
  if (/(감사|고맙|도움.*됐|유익|좋은\s*정보|잘\s*봤|thank)/i.test(t)) {
    return { category: "thanks", confidence: 0.92, reason: "gratitude_pattern" };
  }
  if (/(상담|문의|연락|전화|예약|의뢰|맡기|세무사.*필요|dm\s*(주세요|부탁)|쪽지)/i.test(t)) {
    return { category: "consultation", confidence: 0.9, reason: "consultation_intent" };
  }
  if (/(부가세|부가가치세|종소세|종합소득세|법인세|양도소득세|증여세|상속세|원천세|세금|세액공제|감면|비용처리|사업자등록|현금영수증|세금계산서|장부|기장|경비|소득세|취득세|재산세|종부세)/i.test(t)) {
    return { category: "tax_question", confidence: 0.94, reason: "tax_keyword" };
  }
  if (/[?？]$/.test(t) || /어떻게|가능한가|되나요|인가요|맞나요|궁금/i.test(t)) {
    return { category: "question", confidence: 0.8, reason: "question_pattern" };
  }
  if (/^(좋아요|최고|굿|👍|👏|🔥|❤️|❤|😍|nice|good)[!.\s]*$/i.test(t)) {
    return { category: "thanks", confidence: 0.85, reason: "positive_short_comment" };
  }
  return { category: "general", confidence: 0.65, reason: "fallback" };
}

function defaultReply(category) {
  if (category === "thanks") return "도움이 되셨다니 다행입니다. 감사합니다 😊";
  if (category === "consultation") return "문의 주셔서 감사합니다. 개별 상황에 따라 판단이 달라질 수 있어 자세한 내용은 프로필의 상담 안내를 통해 남겨주시면 확인하겠습니다.";
  return "";
}

function shouldAutoReply(classification) {
  if (REPLY_MODE !== "safe_auto") return false;
  if (!AUTO_CATEGORIES.has(classification.category)) return false;
  return classification.confidence >= 0.8;
}

function extractCommentEvents(payload) {
  const events = [];
  for (const entry of Array.isArray(payload && payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      if (!change || !["comments", "live_comments"].includes(change.field)) continue;
      const v = change.value || {};
      const from = v.from || {};
      const media = v.media || {};
      const id = String(v.id || v.comment_id || "").trim();
      if (!id) continue;
      events.push({
        entry_id: String(entry.id || ""),
        comment_id: id,
        parent_id: String(v.parent_id || ""),
        media_id: String(v.media_id || media.id || ""),
        text: cleanText(v.text || ""),
        from_id: String(from.id || ""),
        from_username: String(from.username || ""),
        timestamp: String(v.timestamp || new Date().toISOString()),
        field: change.field
      });
    }
  }
  return events;
}

async function graphRequest(method, endpoint, params, body, attempt) {
  const currentAttempt = attempt || 1;
  const url = new URL(GRAPH_BASE + "/" + API_VERSION + "/" + String(endpoint).replace(/^\/+/, ""));
  const headers = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const accessToken = runtimeAccessToken();
  if (accessToken && !url.searchParams.has("access_token")) url.searchParams.set("access_token", accessToken);

  let fetchBody;
  if (body !== undefined && body !== null) {
    headers["content-type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(url, { method, headers, body: fetchBody });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch (_) { data = { raw: responseText }; }

  if (response.ok) return data;

  const retryable = response.status === 429 || response.status >= 500;
  if (retryable && currentAttempt < 4) {
    const delay = Math.min(1000 * Math.pow(2, currentAttempt - 1), 8000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return graphRequest(method, endpoint, params, body, currentAttempt + 1);
  }

  const error = new Error("graph_http_" + response.status + ":" + JSON.stringify(data).slice(0, 800));
  error.status = response.status;
  error.graph = data;
  throw error;
}

async function replyToComment(commentId, message) {
  if (!runtimeAccessToken()) throw new Error("INSTAGRAM_ACCESS_TOKEN_missing");
  if (!message) throw new Error("reply_message_empty");
  return graphRequest("POST", encodeURIComponent(commentId) + "/replies", { message }, null);
}

async function fetchMedia(mediaId) {
  if (!mediaId) return null;
  try {
    return await graphRequest("GET", encodeURIComponent(mediaId), {
      fields: "id,caption,media_type,permalink,timestamp"
    }, null);
  } catch (error) {
    log("media_fetch_failed", { media_id: mediaId, error: error.message });
    return null;
  }
}

async function processCommentEvent(event, options) {
  const dryRun = Boolean(options && options.dryRun);
  if (!event.comment_id) return { skipped: true, reason: "comment_id_missing" };
  if (!dryRun && alreadyProcessed(event.comment_id)) {
    return { skipped: true, reason: "already_processed" };
  }

  const currentAccountId = runtimeAccountId();
  if (event.from_id && currentAccountId && event.from_id === currentAccountId) {
    if (!dryRun) rememberProcessed(event.comment_id, { skipped: "self_comment" });
    return { skipped: true, reason: "self_comment" };
  }

  const classification = classifyComment(event.text);
  const reply = defaultReply(classification.category);
  const media = dryRun ? null : await fetchMedia(event.media_id);
  const review = {
    id: crypto.randomUUID(),
    status: "pending",
    created_at: new Date().toISOString(),
    event,
    classification,
    suggested_reply: reply,
    media: media ? {
      id: media.id || event.media_id,
      caption: cleanText(media.caption || "").slice(0, 2000),
      permalink: media.permalink || "",
      media_type: media.media_type || ""
    } : null
  };

  if (dryRun) return { dry_run: true, classification, suggested_reply: reply, would_auto_reply: shouldAutoReply(classification) };

  if (classification.category === "spam" || classification.category === "empty") {
    rememberProcessed(event.comment_id, { skipped: classification.category });
    addAction({ at: new Date().toISOString(), type: "skip", comment_id: event.comment_id, reason: classification.category });
    return { skipped: true, reason: classification.category };
  }

  if (shouldAutoReply(classification) && reply) {
    try {
      const result = await replyToComment(event.comment_id, reply);
      rememberProcessed(event.comment_id, { replied: true, category: classification.category, result_id: result.id || "" });
      addAction({
        at: new Date().toISOString(),
        type: "auto_reply",
        comment_id: event.comment_id,
        category: classification.category,
        message: reply,
        result_id: result.id || ""
      });
      return { replied: true, classification, message: reply, result };
    } catch (error) {
      review.status = "reply_failed";
      review.error = error.message;
      addReview(review);
      rememberProcessed(event.comment_id, { reply_failed: true, error: error.message });
      return { replied: false, error: error.message, queued_for_review: true };
    }
  }

  addReview(review);
  rememberProcessed(event.comment_id, { queued_for_review: true, category: classification.category });
  return { queued_for_review: true, classification, suggested_reply: reply };
}

async function processWebhookPayload(payload) {
  const events = extractCommentEvents(payload);
  log("webhook_comments_received", { count: events.length });
  for (const event of events) {
    try {
      const result = await processCommentEvent(event, { dryRun: false });
      log("comment_processed", { comment_id: event.comment_id, result });
    } catch (error) {
      log("comment_processing_failed", { comment_id: event.comment_id, error: error.message });
    }
  }
}

function mediaSignature(id, exp) {
  return crypto.createHmac("sha256", MEDIA_SECRET).update(String(id) + ":" + String(exp)).digest("hex");
}

function mediaUrl(id, expiresSeconds) {
  if (!PUBLIC_BASE_URL) throw new Error("INSTAGRAM_PUBLIC_BASE_URL_missing");
  if (!MEDIA_SECRET) throw new Error("INSTAGRAM_MEDIA_SIGNING_SECRET_missing");
  const exp = Math.floor(Date.now() / 1000) + (expiresSeconds || 3600);
  const sig = mediaSignature(id, exp);
  return PUBLIC_BASE_URL + "/instagram/media/" + encodeURIComponent(id) + ".jpg?exp=" + exp + "&sig=" + sig;
}

function verifyMediaRequest(id, exp, sig) {
  if (!MEDIA_SECRET || !exp || !sig) return false;
  const n = Number(exp);
  if (!Number.isFinite(n) || n < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(mediaSignature(id, n), sig);
}

function saveJpegBase64(value) {
  const raw = String(value || "").replace(/^data:image\/jpeg;base64,/i, "");
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length < 1000 || buffer.length > 8 * 1024 * 1024) throw new Error("jpeg_size_invalid");
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) throw new Error("jpeg_required");
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(MEDIA_DIR, id + ".jpg"), buffer);
  return { id, bytes: buffer.length, path: path.join(MEDIA_DIR, id + ".jpg") };
}

async function createImageContainer(imageUrl, caption, isCarouselItem, altText) {
  const accountId = runtimeAccountId();
  if (!accountId) throw new Error("INSTAGRAM_ACCOUNT_ID_missing");
  const params = { image_url: imageUrl };
  if (caption) params.caption = caption;
  if (isCarouselItem) params.is_carousel_item = "true";
  if (altText) params.alt_text = altText;
  return graphRequest("POST", encodeURIComponent(accountId) + "/media", params, null);
}

async function waitContainerReady(containerId) {
  for (let i = 0; i < 15; i += 1) {
    const status = await graphRequest("GET", encodeURIComponent(containerId), { fields: "status_code,status" }, null);
    const code = String(status.status_code || "").toUpperCase();
    if (!code || code === "FINISHED" || code === "PUBLISHED") return status;
    if (code === "ERROR" || code === "EXPIRED") throw new Error("container_" + code.toLowerCase() + ":" + JSON.stringify(status));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("container_not_ready_timeout");
}

async function publishImages(payload) {
  if (!runtimeAccessToken()) throw new Error("INSTAGRAM_ACCESS_TOKEN_missing");
  const accountId = runtimeAccountId();
  if (!accountId) throw new Error("INSTAGRAM_ACCOUNT_ID_missing");
  if (!PUBLIC_BASE_URL) throw new Error("INSTAGRAM_PUBLIC_BASE_URL_missing");
  if (!MEDIA_SECRET) throw new Error("INSTAGRAM_MEDIA_SIGNING_SECRET_missing");

  const caption = cleanText(payload.caption || "");
  const items = Array.isArray(payload.images) ? payload.images : [];
  if (items.length < 1 || items.length > 10) throw new Error("images_count_must_be_1_to_10");

  const saved = items.map((item) => {
    const record = saveJpegBase64(item && (item.jpeg_base64 || item.data_base64 || item.base64));
    record.alt_text = cleanText(item && item.alt_text || "").slice(0, 1000);
    record.url = mediaUrl(record.id, 7200);
    return record;
  });

  try {
    let creationId;
    if (saved.length === 1) {
      const created = await createImageContainer(saved[0].url, caption, false, saved[0].alt_text);
      creationId = created.id;
      if (!creationId) throw new Error("container_id_missing");
      await waitContainerReady(creationId);
    } else {
      const children = [];
      for (const item of saved) {
        const created = await createImageContainer(item.url, "", true, item.alt_text);
        if (!created.id) throw new Error("carousel_child_id_missing");
        await waitContainerReady(created.id);
        children.push(created.id);
      }
      const parent = await graphRequest("POST", encodeURIComponent(accountId) + "/media", {
        media_type: "CAROUSEL",
        caption,
        children: children.join(",")
      }, null);
      creationId = parent.id;
      if (!creationId) throw new Error("carousel_container_id_missing");
      await waitContainerReady(creationId);
    }

    const published = await graphRequest("POST", encodeURIComponent(accountId) + "/media_publish", {
      creation_id: creationId
    }, null);

    addAction({
      at: new Date().toISOString(),
      type: "publish",
      creation_id: creationId,
      media_id: published.id || "",
      image_count: saved.length,
      caption: caption.slice(0, 500)
    });

    return {
      ok: true,
      creation_id: creationId,
      media_id: published.id || "",
      image_count: saved.length
    };
  } catch (error) {
    addAction({
      at: new Date().toISOString(),
      type: "publish_failed",
      error: error.message,
      image_count: saved.length,
      caption: caption.slice(0, 500)
    });
    throw error;
  }
}

function cleanupMedia() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      if (!/^[a-f0-9-]+\.jpg$/i.test(name)) continue;
      const full = path.join(MEDIA_DIR, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch (error) {
    log("media_cleanup_failed", { error: error.message });
  }
}

function statusPayload() {
  const connection = runtimeConnection();
  const dashboardStatus = dashboard.dashboardStatus();
  return {
    ok: true,
    service: "instagram-automation",
    api_version: API_VERSION,
    reply_mode: REPLY_MODE,
    auto_categories: Array.from(AUTO_CATEGORIES),
    configured: {
      access_token: Boolean(connection.accessToken),
      account_id: Boolean(connection.accountId),
      app_secret: Boolean(runtimeAppSecret()),
      verify_token: Boolean(VERIFY_TOKEN),
      admin_token: Boolean(ADMIN_TOKEN),
      public_base_url: Boolean(PUBLIC_BASE_URL),
      media_signing_secret: Boolean(MEDIA_SECRET)
    },
    instagram: dashboardStatus,
    public_base_url: PUBLIC_BASE_URL || null,
    state_dir: STATE_DIR
  };
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (await dashboard.handle(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, statusPayload());
  }

  if (req.method === "GET" && url.pathname === "/instagram/webhook") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && VERIFY_TOKEN && safeEqual(token, VERIFY_TOKEN)) {
      return text(res, 200, String(challenge || ""));
    }
    return json(res, 403, { error: "webhook_verification_failed" });
  }

  if (req.method === "POST" && url.pathname === "/instagram/webhook") {
    const raw = await readBody(req, 2 * 1024 * 1024);
    const check = verifyWebhookSignature(raw, req.headers["x-hub-signature-256"]);
    if (!check.ok) return json(res, 401, { error: check.reason });
    const payload = parseJson(raw);
    json(res, 200, { ok: true });
    setImmediate(() => processWebhookPayload(payload).catch((error) => log("webhook_async_failed", { error: error.message })));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/instagram/media/")) {
    const match = url.pathname.match(/^\/instagram\/media\/([a-f0-9-]+)\.jpg$/i);
    if (!match) return json(res, 404, { error: "not_found" });
    const id = match[1];
    if (!verifyMediaRequest(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return json(res, 403, { error: "media_signature_invalid" });
    }
    const file = path.join(MEDIA_DIR, id + ".jpg");
    if (!fs.existsSync(file)) return json(res, 404, { error: "media_not_found" });
    res.statusCode = 200;
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "public, max-age=300");
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (!adminAuthorized(req, url)) return json(res, 403, { error: "admin_forbidden" });

  if (req.method === "GET" && url.pathname === "/instagram/status") {
    const state = loadState();
    return json(res, 200, {
      ...statusPayload(),
      reviews: state.reviews.length,
      processed: Object.keys(state.processed).length,
      actions: state.actions.slice(0, 20)
    });
  }

  if (req.method === "GET" && url.pathname === "/instagram/reviews") {
    const state = loadState();
    const status = url.searchParams.get("status");
    const reviews = status ? state.reviews.filter((r) => r.status === status) : state.reviews;
    return json(res, 200, { reviews: reviews.slice(0, 200) });
  }

  if (req.method === "POST" && url.pathname === "/instagram/simulate-comment") {
    const payload = parseJson(await readBody(req, 1024 * 1024));
    const event = {
      entry_id: "simulation",
      comment_id: String(payload.comment_id || crypto.randomUUID()),
      parent_id: "",
      media_id: String(payload.media_id || ""),
      text: cleanText(payload.text || ""),
      from_id: String(payload.from_id || "simulated-user"),
      from_username: String(payload.from_username || "simulation"),
      timestamp: new Date().toISOString(),
      field: "comments"
    };
    const result = await processCommentEvent(event, { dryRun: true });
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname.match(/^\/instagram\/reviews\/[^/]+\/reply$/)) {
    const reviewId = decodeURIComponent(url.pathname.split("/")[3] || "");
    const body = parseJson(await readBody(req, 1024 * 1024));
    const state = loadState();
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review) return json(res, 404, { error: "review_not_found" });
    if (!review.event || !review.event.comment_id) return json(res, 400, { error: "comment_id_missing" });
    const message = cleanText(body.message || review.suggested_reply || "");
    if (!message) return json(res, 400, { error: "reply_message_empty" });

    const result = await replyToComment(review.event.comment_id, message);
    review.status = "replied";
    review.replied_at = new Date().toISOString();
    review.final_reply = message;
    review.result_id = result.id || "";
    saveState(state);
    addAction({
      at: new Date().toISOString(),
      type: "manual_reply",
      review_id: review.id,
      comment_id: review.event.comment_id,
      message,
      result_id: result.id || ""
    });
    return json(res, 200, { ok: true, result });
  }

  if (req.method === "POST" && url.pathname === "/instagram/publish") {
    const payload = parseJson(await readBody(req, MAX_BODY));
    const result = await publishImages(payload);
    cleanupMedia();
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/instagram/quota") {
    const accountId = runtimeAccountId();
    if (!accountId) return json(res, 400, { error: "INSTAGRAM_ACCOUNT_ID_missing" });
    const result = await graphRequest("GET", encodeURIComponent(accountId) + "/content_publishing_limit", {
      fields: "config,quota_usage"
    }, null);
    return json(res, 200, result);
  }

  return json(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    log("request_failed", { method: req.method, url: req.url, error: error.message });
    if (!res.headersSent) json(res, 500, { error: error.message });
    else res.end();
  });
});

server.listen(PORT, () => {
  cleanupMedia();
  log("instagram_service_started", statusPayload());
});
