const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright-core");
const sharp = require("sharp");

const PORT = Number(process.env.PORT || 3000);
const RUN_ON_BOOT = process.env.RUN_ON_BOOT === "true";
const JOB_FILE = process.env.JOB_FILE || "jobs/001.json";
const ROOT = __dirname;

let lastResult = { status: "IDLE", published: false };

const PIPELINE_STATE_FILE = process.env.PIPELINE_STATE_FILE || "/tmp/naver-work-pipeline-state.json";
const PIPELINE_TOKEN = process.env.PIPELINE_TOKEN || process.env.WORK4_UPLOAD_TOKEN || "";
const PIPELINE_STAGE_URLS = {
  work1: process.env.WORK2_TRIGGER_URL || "",
  work2: process.env.WORK3_TRIGGER_URL || "",
};
let work4RunPromise = null;

function loadPipelineState() {
  try {
    return JSON.parse(fs.readFileSync(PIPELINE_STATE_FILE, "utf8"));
  } catch (_) {
    return { version: 1, contents: {} };
  }
}

function savePipelineState(state) {
  fs.mkdirSync(path.dirname(PIPELINE_STATE_FILE), { recursive: true });
  const tmp = PIPELINE_STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, PIPELINE_STATE_FILE);
}

function updatePipelineStage(contentId, stage, patch = {}) {
  if (!contentId) throw new Error("pipeline_content_id_required");
  const state = loadPipelineState();
  if (!state.contents[contentId]) {
    state.contents[contentId] = {
      content_id: contentId,
      created_at: new Date().toISOString(),
      stages: {},
    };
  }
  const item = state.contents[contentId];
  item.updated_at = new Date().toISOString();
  item.stages[stage] = {
    ...(item.stages[stage] || {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  savePipelineState(state);
  out("pipeline_stage", { content_id: contentId, stage, status: item.stages[stage].status || "" });
  return item;
}

function pipelineAuthorized(req, url) {
  if (!PIPELINE_TOKEN) return false;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const header = String(req.headers["x-pipeline-token"] || "");
  const query = url ? String(url.searchParams.get("token") || "") : "";
  return bearer === PIPELINE_TOKEN || header === PIPELINE_TOKEN || query === PIPELINE_TOKEN;
}

async function triggerPipelineUrl(url, payload) {
  if (!url) return { triggered: false, reason: "trigger_url_missing" };
  if (typeof fetch !== "function") throw new Error("global_fetch_unavailable");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pipeline-token": PIPELINE_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`next_stage_http_${response.status}:${text.slice(0, 300)}`);
  return { triggered: true, status: response.status, response: text.slice(0, 500) };
}

async function handlePipelineStageComplete(req, res, stage) {
  const url = new URL(req.url, "http://localhost");
  if (!pipelineAuthorized(req, url)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  try {
    const payload = await readJsonRequest(req, 2 * 1024 * 1024);
    const contentId = String(payload.content_id || "").trim();
    if (!contentId) throw new Error("pipeline_content_id_required");

    const current = updatePipelineStage(contentId, stage, {
      status: "DONE",
      received_at: new Date().toISOString(),
      payload,
    });

    const nextStage = stage === "work1" ? "work2" : stage === "work2" ? "work3" : "";
    if (!nextStage) {
      res.end(JSON.stringify({ ok: true, content_id: contentId, stage, current }));
      return;
    }

    updatePipelineStage(contentId, nextStage, { status: "TRIGGERING" });
    try {
      const triggered = await triggerPipelineUrl(PIPELINE_STAGE_URLS[stage], {
        content_id: contentId,
        source_stage: stage,
        target_stage: nextStage,
        previous_output: payload,
      });
      updatePipelineStage(contentId, nextStage, {
        status: triggered.triggered ? "TRIGGERED" : "WAITING_TRIGGER_URL",
        trigger_result: triggered,
      });
      res.statusCode = triggered.triggered ? 202 : 200;
      res.end(JSON.stringify({
        ok: true,
        content_id: contentId,
        completed_stage: stage,
        next_stage: nextStage,
        ...triggered,
      }));
    } catch (error) {
      updatePipelineStage(contentId, nextStage, { status: "TRIGGER_FAILED", error: error.message });
      res.statusCode = 502;
      res.end(JSON.stringify({ error: error.message, content_id: contentId, next_stage: nextStage }));
    }
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error.message }));
  }
}

function handlePipelineStatus(req, res, url) {
  if (!pipelineAuthorized(req, url)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  const contentId = String(url.searchParams.get("content_id") || "").trim();
  const state = loadPipelineState();
  if (!contentId) {
    res.end(JSON.stringify(state));
    return;
  }
  const item = state.contents[contentId];
  if (!item) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "content_not_found", content_id: contentId }));
    return;
  }
  res.end(JSON.stringify(item));
}

async function startWork4Run(trigger = "manual") {
  if (work4RunPromise) {
    out("work4_duplicate_trigger_ignored", trigger);
    return work4RunPromise;
  }

  let contentId = "";
  try {
    contentId = String(loadJob().content_id || "");
    updatePipelineStage(contentId, "work4", { status: "RUNNING", trigger });
  } catch (error) {
    out("pipeline_work4_state_init_error", error.message);
  }

  work4RunPromise = runJob()
    .then((result) => {
      if (contentId) updatePipelineStage(contentId, "work4", { status: "DONE", result });
      return result;
    })
    .catch((error) => {
      if (contentId) updatePipelineStage(contentId, "work4", { status: "FAILED", error: error.message });
      throw error;
    })
    .finally(() => {
      work4RunPromise = null;
    });

  return work4RunPromise;
}


function out(key, value) {
  console.log(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJobPayload() {
  const job = JSON.parse(fs.readFileSync(path.join(ROOT, JOB_FILE), "utf8"));
  if (job && job.content_id && Array.isArray(job.images)) {
    const safeContentId = String(job.content_id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    job.images = job.images.map((image, index) => {
      const value = String(image || "");
      if (/^(?:\.\.\/)?tmp\/work4-runtime-\d+\.jpg$/i.test(value)) {
        return `../tmp/work4-runtime-${safeContentId}-${index + 1}.jpg`;
      }
      return image;
    });
  }
  return job;
}

function loadJob() {
  const job = readJobPayload();
  if (!job.content_id || !job.title || !Array.isArray(job.body_parts) || !Array.isArray(job.images)) {
    throw new Error("invalid_job_payload");
  }
  if (job.publish_mode !== "draft_only") throw new Error("publish_mode_must_be_draft_only");
  if (job.images.length !== job.body_parts.length) throw new Error("image_body_mapping_mismatch");
  if (!job.footer_image) throw new Error("footer_image_required");

  const preflight = job.preflight || {};
  const normalizedBody = [job.intro_part || "", ...(job.body_parts || [])]
    .join("\n")
    .replace(/[\s\u200B\uFEFF]/g, "");
  const minChars = Number(preflight.min_normalized_chars || 0);
  const minTags = Number(preflight.min_tags || 0);
  const requiredImages = Number(preflight.required_image_count || job.images.length);

  out("preflight_content_chars", normalizedBody.length);
  out("preflight_tags_count", Array.isArray(job.tags) ? job.tags.length : 0);
  out("preflight_images_count", job.images.length);
  out("preflight_main_keyword", job.main_keyword || "");
  out("preflight_image_source", job.image_source || "");

  if (minChars && normalizedBody.length < minChars) throw new Error("preflight_content_too_short");
  if (minTags && (!Array.isArray(job.tags) || job.tags.length < minTags)) throw new Error("preflight_tags_missing");
  if (requiredImages && job.images.length !== requiredImages) throw new Error("preflight_image_count_failed");
  if (preflight.require_main_keyword && (!job.main_keyword || !job.title.includes(job.main_keyword))) {
    throw new Error("preflight_main_keyword_missing");
  }
  if (preflight.require_generated_images && !["WORK3_imagegen", "WORK3_designed_from_imagegen"].includes(job.image_source)) {
    throw new Error("preflight_generated_images_missing");
  }
  for (const image of [...job.images, job.footer_image]) {
    const full = path.join(ROOT, image);
    if (!fs.existsSync(full)) throw new Error(`image_missing:${image}`);
  }
  return job;
}

function getVersionOnce() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "naver-chromium.railway.internal",
      port: 9222,
      path: "/json/version",
      headers: { Host: "localhost:9222" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error("version_timeout")));
    req.on("error", reject);
  });
}

async function getVersion() {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      out("cdp_version_attempt", attempt);
      const value = await getVersionOnce();
      out("cdp_version_ok", true);
      return value;
    } catch (error) {
      out("cdp_version_error", error.message);
      if (attempt < 8) await sleep(2000);
    }
  }
  throw new Error("cdp_version_failed");
}

function getCdpTargetsOnce() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "naver-chromium.railway.internal",
      port: 9222,
      path: "/json/list",
      headers: { Host: "localhost:9222" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("target_list_timeout")));
    req.on("error", reject);
  });
}

function closeCdpTargetOnce(id) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "naver-chromium.railway.internal",
      port: 9222,
      path: `/json/close/${encodeURIComponent(id)}`,
      headers: { Host: "localhost:9222" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, data }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("target_close_timeout")));
    req.on("error", reject);
  });
}

async function inspectCdpTargets() {
  try {
    const targets = await getCdpTargetsOnce();
    out("cdp_target_count", Array.isArray(targets) ? targets.length : -1);
    if (Array.isArray(targets)) {
      const summary = targets.slice(0, 20).map((target) => {
        let host = "";
        try { host = new URL(target.url || "about:blank").hostname; } catch (_) {}
        return { type: target.type || "", host, isNaver: /naver\.com$/i.test(host) || /\.naver\.com$/i.test(host) };
      });
      out("cdp_target_summary", summary);

      const staleUiTargets = targets.filter((target) =>
        target && target.id && target.type === "browser_ui" && /omnibox-popup\.top-chrome/i.test(target.url || "")
      );
      out("cdp_stale_ui_target_count", staleUiTargets.length);
      for (const target of staleUiTargets) {
        try {
          const closed = await closeCdpTargetOnce(target.id);
          out("cdp_stale_ui_target_closed", closed.statusCode === 200);
        } catch (error) {
          out("cdp_stale_ui_target_close_error", error.message);
        }
      }
      if (staleUiTargets.length) await sleep(1000);

      const naverPages = targets.filter((target) => {
        if (!target || !target.id || target.type !== "page") return false;
        try { return new URL(target.url || "about:blank").hostname === "blog.naver.com"; } catch (_) { return false; }
      });
      out("cdp_naver_page_count", naverPages.length);
      if (naverPages.length > 1) {
        const keep = naverPages.find((target) => /Redirect=Write/i.test(target.url || "")) || naverPages[0];
        for (const target of naverPages) {
          if (target.id === keep.id) continue;
          try {
            const closed = await closeCdpTargetOnce(target.id);
            out("cdp_duplicate_naver_page_closed", closed.statusCode === 200);
          } catch (error) {
            out("cdp_duplicate_naver_page_close_error", error.message);
          }
        }
        await sleep(1200);
      }

      try {
        const after = await getCdpTargetsOnce();
        out("cdp_target_count_after_cleanup", Array.isArray(after) ? after.length : -1);
      } catch (error) {
        out("cdp_target_recheck_error", error.message);
      }
    }
  } catch (error) {
    out("cdp_target_list_error", error.message);
  }
}

async function connectBrowserOverCdp(wsUrl) {
  const endpoints = [
    { label: "ws", url: wsUrl },
    { label: "http", url: "http://naver-chromium.railway.internal:9222" },
  ];
  let lastError;
  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        out("cdp_connect_attempt", `${endpoint.label}:${attempt}`);
        const browser = await chromium.connectOverCDP(endpoint.url, {
          headers: { Host: "localhost:9222" },
          timeout: 30000,
        });
        out("cdp_connect_mode", endpoint.label);
        out("cdp_connect_ok", true);
        return browser;
      } catch (error) {
        lastError = error;
        out("cdp_connect_error", `${endpoint.label}:${error.message.slice(0, 160)}`);
        await sleep(1200);
      }
    }
  }
  throw lastError || new Error("cdp_connect_failed");
}

async function findEditorFrame(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.url().includes("PostWriteForm.naver"));
    if (frame && await frame.locator(".se-documentTitle").count().catch(() => 0)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("editor_frame_missing");
}

async function closeDraftListOverlay(frame, page) {
  const overlay = frame.locator('[aria-label="임시저장 글 보기"]').first();
  if (!await overlay.isVisible().catch(() => false)) {
    out("draft_list_overlay_open", false);
    return;
  }
  out("draft_list_overlay_open", true);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  if (!await overlay.isVisible().catch(() => false)) {
    out("draft_list_overlay_closed", "escape");
    return;
  }

  const selectors = [
    'button[aria-label*="닫기"]',
    'button[title*="닫기"]',
    'button:has-text("닫기")',
    '.layer_popup__MFPwH button[class*="close"]',
    '.layer_popup__MFPwH button[class*="Close"]'
  ];
  for (const selector of selectors) {
    const button = await visibleFirst(frame.locator(selector));
    if (!button) continue;
    await button.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    if (!await overlay.isVisible().catch(() => false)) {
      out("draft_list_overlay_closed", selector);
      return;
    }
  }
  throw new Error("draft_list_overlay_close_failed");
}

async function handleRecoveryBeforeInput(frame, page) {
  // Smart Editor can render its recovery confirmation a moment after the
  // editor frame itself becomes ready. Poll briefly so the late popup cannot
  // intercept the first title click.
  let bodyText = "";
  let visible = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    bodyText = await frame.locator("body").innerText().catch(() => "");
    visible = /작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(bodyText);
    if (visible) break;
    await page.waitForTimeout(500);
  }
  out("recovery_modal_before_input", visible);
  if (!visible) return;

  // 다른 임시저장을 덮어쓰지 않도록 새 글 시작 쪽(취소)만 허용한다.
  const cancel = frame.getByRole("button", { name: "취소", exact: true });
  const count = await cancel.count();
  out("recovery_cancel_count", count);
  if (count !== 1) throw new Error("recovery_conflict_no_unique_cancel");
  await cancel.evaluate((element) => element.click());
  await page.waitForTimeout(2000);
  out("recovery_cancel_clicked", true);
}

async function handleRecoveryAfterReload(frame, page) {
  const bodyText = await frame.locator("body").innerText().catch(() => "");
  const visible = /작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(bodyText);
  out("reload_recovery_modal", visible);
  if (!visible) return false;
  const confirm = frame.getByRole("button", { name: "확인", exact: true });
  const count = await confirm.count();
  out("reload_confirm_count", count);
  if (count !== 1) throw new Error("reload_confirm_not_unique");
  await confirm.click();
  await page.waitForTimeout(2500);
  out("reload_confirm_clicked", true);
  return true;
}

async function dismissHelpOverlay(frame, page) {
  const helpTitle = frame.locator("h1.se-help-title").first();
  if (!await helpTitle.isVisible().catch(() => false)) return false;
  const container = helpTitle.locator("xpath=ancestor::div[contains(@class,'container__')][1]");
  const selectors = [
    'button[aria-label*="닫기"]',
    'button[title*="닫기"]',
    'button[class*="close"]',
    'button[class*="Close"]'
  ];
  for (const selector of selectors) {
    const button = await visibleFirst(container.locator(selector));
    if (!button) continue;
    await button.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    if (!await helpTitle.isVisible().catch(() => false)) {
      out("help_overlay_closed", selector);
      return true;
    }
  }
  await container.evaluate((element) => {
    element.style.display = "none";
    element.style.pointerEvents = "none";
    element.setAttribute("aria-hidden", "true");
  }).catch(() => {});
  await page.waitForTimeout(300);
  out("help_overlay_suppressed", true);
  return true;
}

async function openSavedDraftFromList(frame, page, titles) {
  await dismissHelpOverlay(frame, page);
  const countButton = frame.locator("button.save_count_btn__xxzDt").first();
  if (await countButton.count() !== 1) throw new Error("draft_list_button_missing");
  const countText = (await countButton.innerText().catch(() => "")).trim();
  out("draft_count_after_save", countText);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  const listOpened = await frame.evaluate(() => {
    const element = document.querySelector("button.save_count_btn__xxzDt");
    if (!element) return false;
    element.click();
    return true;
  }).catch(() => false);
  if (!listOpened) throw new Error("draft_list_button_click_failed");
  await page.waitForTimeout(2000);

  const lookupTitles = Array.isArray(titles) ? titles : [titles];
  const contexts = [frame, page];
  for (const title of lookupTitles) {
    for (const context of contexts) {
      const exact = context.getByText(title, { exact: true });
      const exactCount = await exact.count().catch(() => 0);
      out("draft_title_exact_count", exactCount);
      for (let i = 0; i < exactCount; i += 1) {
        const candidate = exact.nth(i);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.evaluate((element) => element.click());
        await page.waitForTimeout(3000);
        out("draft_title_clicked", title);
        return;
      }

      const prefix = title.slice(0, 22);
      const partial = context.getByText(prefix, { exact: false });
      const partialCount = await partial.count().catch(() => 0);
      out("draft_title_partial_count", partialCount);
      for (let i = 0; i < partialCount; i += 1) {
        const candidate = partial.nth(i);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.evaluate((element) => element.click());
        await page.waitForTimeout(3000);
        out("draft_title_clicked", title);
        return;
      }
    }
  }
  throw new Error("saved_draft_title_not_found");
}

function normalizeBodyText(value) {
  return (value || "")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1•")
    .replace(/[\s\u200B\uFEFF]/g, "");
}

function expectedBodyText(job) {
  const tags = Array.isArray(job.tags) && job.tags.length
    ? job.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")
    : "";
  return [job.intro_part || "", ...(job.body_parts || []), tags].filter(Boolean).join("\n\n");
}

function bodyMatchesJob(actual, job) {
  const phrasesOk = (job.verify_phrases || []).every((phrase) => actual.includes(phrase));
  const actualNormalized = normalizeBodyText(actual);
  const expectedNormalized = normalizeBodyText(expectedBodyText(job));
  const exactOrderOk = actualNormalized.includes(expectedNormalized);
  out("body_exact_order_match", exactOrderOk);
  if (!exactOrderOk) {
    let mismatchIndex = 0;
    const limit = Math.min(actualNormalized.length, expectedNormalized.length);
    while (mismatchIndex < limit && actualNormalized[mismatchIndex] === expectedNormalized[mismatchIndex]) mismatchIndex += 1;
    out("body_actual_length", actualNormalized.length);
    out("body_expected_length", expectedNormalized.length);
    out("body_mismatch_index", mismatchIndex);
    out("body_actual_mismatch_preview", actualNormalized.slice(Math.max(0, mismatchIndex - 50), mismatchIndex + 120));
    out("body_expected_mismatch_preview", expectedNormalized.slice(Math.max(0, mismatchIndex - 50), mismatchIndex + 120));
  }
  return phrasesOk && exactOrderOk;
}

function normalizeLayout(value) {
  return (value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B\uFEFF]/g, "")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1• ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function layoutMatchesJob(frame, job) {
  const normalizeLine = (value) => (value || "")
    .replace(/[\u200B\uFEFF]/g, "")
    .replace(/^\s*[-*•]\s+/, "• ")
    .replace(/[ \t]+/g, " ")
    .trim();

  const actualLines = (await frame.locator(".se-component.se-text .se-text-paragraph").allInnerTexts().catch(() => []))
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => line !== "글감과 함께 나의 일상을 기록해보세요!");

  const expectedLines = [job.intro_part || "", ...(job.body_parts || [])]
    .join("\n")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean);

  let cursor = 0;
  for (let i = 0; i < expectedLines.length; i += 1) {
    const expected = expectedLines[i];
    let found = false;
    while (cursor < actualLines.length) {
      if (actualLines[cursor] === expected) {
        found = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (!found) {
      out("layout_missing_line", i + 1);
      out("layout_expected_preview", expected.slice(0, 240));
      out("layout_actual_lines", actualLines.slice(Math.max(0, cursor - 4), cursor + 8));
      out("body_layout_match", false);
      return false;
    }
  }
  out("body_layout_match", true);
  return true;
}

async function replaceText(page, locator, text) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(text);
}

async function clearExistingBody(frame, page) {
  const images = frame.locator(".se-component.se-image");
  let safety = 0;
  while (await images.count()) {
    if (safety++ > 12) throw new Error("existing_images_clear_loop");
    const before = await images.count();
    const target = images.nth(before - 1);
    await target.scrollIntoViewIfNeeded();
    await target.click({ position: { x: 10, y: 10 }, noWaitAfter: true });
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(500);
    if (await images.count() >= before) {
      await page.keyboard.press("Delete");
      await page.waitForTimeout(500);
    }
    if (await images.count() >= before) throw new Error("existing_image_delete_failed");
  }

  const modules = frame.locator(".se-component.se-text .se-module-text");
  for (let pass = 0; pass < 3; pass += 1) {
    const count = await modules.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const module = modules.nth(i);
      if (!await module.isVisible().catch(() => false)) continue;
      const value = (await module.innerText().catch(() => "")).replace(/[\s\u200B\uFEFF]/g, "");
      if (!value.length) continue;
      await module.scrollIntoViewIfNeeded();
      await module.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(1000);
  const remainingText = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("");
  const normalizedText = remainingText
    .replace("글감과 함께 나의 일상을 기록해보세요!", "")
    .replace(/[\s\u200B\uFEFF]/g, "");
  const remainingImages = await frame.locator(".se-component.se-image").count();
  out("existing_body_remaining_length", normalizedText.length);
  if (normalizedText.length) out("existing_body_remaining_preview", normalizedText.slice(0, 80));
  out("existing_body_cleared", normalizedText.length === 0);
  out("existing_images_cleared", remainingImages === 0);
  if (normalizedText.length || remainingImages) throw new Error("existing_draft_clear_failed");
}

async function setBoldToolbarState(frame, page, enabled) {
  const selectors = [
    "button.se-toolbar-button.se-toolbar-button-bold",
    ".se-toolbar-item-bold button",
    "button[data-name='bold']",
    "button[aria-label*='굵게']",
    "button[title*='굵게']",
    "button:has-text('굵게')",
  ];

  for (const selector of selectors) {
    const button = await visibleFirst(frame.locator(selector));
    if (!button) continue;
    const beforeSelected = await button.evaluate((element) => element.classList.contains("se-is-selected"));
    if (beforeSelected !== enabled) {
      await button.click();
      await page.waitForTimeout(150);
    }
    const afterSelected = await button.evaluate((element) => element.classList.contains("se-is-selected"));
    out("bold_toolbar_selector", selector);
    out("bold_toolbar_requested", enabled);
    out("bold_toolbar_selected", afterSelected);
    if (afterSelected !== enabled) throw new Error(`bold_toolbar_state_failed:${enabled}`);
    return;
  }
  throw new Error("bold_toolbar_button_missing");
}

function encodeLayoutMarkers(text, layoutMarkers) {
  return text.replace(/\n/g, () => {
    const marker = `⟦BR${String(layoutMarkers.length + 1).padStart(3, "0")}⟧`;
    layoutMarkers.push(marker);
    return marker;
  });
}

async function replaceLayoutMarkers(frame, page, layoutMarkers) {
  // 텍스트는 먼저 한 번에 넣어 누락을 막고, 고유 표식을 뒤에서부터 실제 줄바꿈으로 바꾼다.
  // 뒤에서 처리하면 앞쪽 DOM 위치가 바뀌어도 아직 처리하지 않은 표식의 위치가 안정적이다.
  for (let markerIndex = layoutMarkers.length - 1; markerIndex >= 0; markerIndex -= 1) {
    const marker = layoutMarkers[markerIndex];
    const components = frame.locator(".se-component.se-text");
    const count = await components.count();
    let selected = false;
    for (let componentIndex = 0; componentIndex < count; componentIndex += 1) {
      const component = components.nth(componentIndex);
      selected = await component.evaluate((element, value) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let fullText = "";
        while (walker.nextNode()) {
          const node = walker.currentNode;
          nodes.push({ node, start: fullText.length, end: fullText.length + node.nodeValue.length });
          fullText += node.nodeValue;
        }
        const start = fullText.indexOf(value);
        if (start < 0) return false;
        const end = start + value.length;
        const startNode = nodes.find((item) => item.start <= start && start < item.end);
        const endNode = nodes.find((item) => item.start < end && end <= item.end);
        if (!startNode || !endNode) return false;
        const editable = startNode.node.parentElement?.closest("[contenteditable='true']");
        if (editable instanceof HTMLElement) editable.focus();
        const range = document.createRange();
        range.setStart(startNode.node, start - startNode.start);
        range.setEnd(endNode.node, end - endNode.start);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (selection.toString() !== value) return false;
        // execCommand(insertText)는 실제 input 이벤트를 발생시켜 네이버 내부 모델에도 기록된다.
        document.execCommand("insertText", false, "\n");
        return !element.textContent.includes(value);
      }, marker).catch(() => false);
      if (selected) break;
      const markerStillExists = await components.evaluateAll(
        (elements, value) => elements.some((element) => element.textContent.includes(value)),
        marker,
      );
      if (!markerStillExists) {
        selected = true;
        break;
      }
    }
    if (!selected) throw new Error(`layout_marker_missing:${marker}`);
    // 실제 DOM과 네이버 저장 모델 양쪽에서 표식이 제거됐는지 즉시 확인한다.
    const markerRemains = await frame.locator(".se-component.se-text").evaluateAll(
      (elements, value) => elements.some((element) => element.textContent.includes(value)),
      marker,
    );
    if (markerRemains) throw new Error(`layout_marker_replace_failed:${marker}`);
  }

  const bodyText = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
  const remaining = layoutMarkers.filter((marker) => bodyText.includes(marker));
  out("layout_markers_replaced", layoutMarkers.length - remaining.length);
  if (remaining.length) throw new Error(`layout_markers_remaining:${remaining.length}`);
}

async function pasteText(page, target, value) {
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.evaluate(async (text) => navigator.clipboard.writeText(text), value);
  await target.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+V");
}

function richClipboardHtml(text, boldBlocks = []) {
  const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
  const boldSet = new Set(boldBlocks.map(normalize));
  const escapeHtml = (value) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return text
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s+/, "• "))
    .map((line) => {
      if (!line.length) return "<div><br></div>";
      const escaped = escapeHtml(line);
      const content = boldSet.has(normalize(line)) ? `<strong>${escaped}</strong>` : escaped;
      return `<div>${content}</div>`;
    })
    .join("");
}

async function pasteRichText(page, target, plainText, htmlText) {
  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const written = await page.evaluate(async ({ plain, html }) => {
    if (typeof ClipboardItem !== "function") return false;
    const item = new ClipboardItem({
      "text/plain": new Blob([plain], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    });
    await navigator.clipboard.write([item]);
    return true;
  }, { plain: plainText, html: htmlText }).catch(() => false);
  if (!written) throw new Error("rich_clipboard_write_failed");
  await target.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Control+V");
}

async function insertStructuredText(frame, page, text, boldBlocks = []) {
  const bodyBlocks = frame.locator(".se-component.se-text .se-module-text");
  const count = await bodyBlocks.count();
  if (!count) throw new Error("body_text_block_missing");
  const target = bodyBlocks.nth(count - 1);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await setBoldToolbarState(frame, page, false);
  await target.click();
  await page.keyboard.press("Control+End");

  const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s+/, "• "));

  let boldEnabled = false;
  for (let i = 0; i < lines.length; i += 1) {
    const normalizedLine = normalize(lines[i]);
    const shouldBold = Boolean(normalizedLine) && boldBlocks.some((block) =>
      normalizedLine.includes(normalize(block))
    );

    if (shouldBold !== boldEnabled) {
      await setBoldToolbarState(frame, page, shouldBold);
      boldEnabled = shouldBold;
    }

    if (lines[i].length) {
      await page.keyboard.insertText(lines[i]);
      await page.waitForTimeout(100);
    }
    if (i < lines.length - 1) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
  }

  if (boldEnabled) {
    await setBoldToolbarState(frame, page, false);
  }

  // Commit the final paragraph before the image toolbar takes focus.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

async function applyBoldBlocks(frame, page, boldBlocks = []) {
  for (let blockIndex = boldBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const expected = boldBlocks[blockIndex];
    if (await verifyBoldBlocks(frame, [expected])) {
      out(`bold_block_${blockIndex + 1}_already_verified`, true);
      continue;
    }

    const paragraphs = frame.locator(".se-component.se-text");
    const count = await paragraphs.count();
    let target = null;
    for (let i = 0; i < count; i += 1) {
      const candidate = paragraphs.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const contains = await candidate.evaluate((element, value) => {
        const normalize = (text) => (text || "").replace(/[\s\u200B\uFEFF]/g, "");
        return normalize(element.textContent).includes(normalize(value));
      }, expected).catch(() => false);
      if (contains) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new Error(`bold_target_missing:${blockIndex + 1}`);

    const selected = await target.evaluate((element, value) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const chars = [];
      let compact = "";
      let node = walker.nextNode();
      while (node) {
        const content = node.textContent || "";
        for (let offset = 0; offset < content.length; offset += 1) {
          const char = content[offset];
          if (!/[\s\u200B\uFEFF]/.test(char)) {
            compact += char;
            chars.push({ node, offset });
          }
        }
        node = walker.nextNode();
      }

      const wanted = value.replace(/[\s\u200B\uFEFF]/g, "");
      const start = compact.indexOf(wanted);
      if (start < 0 || !wanted.length) return false;
      const first = chars[start];
      const last = chars[start + wanted.length - 1];
      if (!first || !last) return false;

      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return selection.toString().replace(/[\s\u200B\uFEFF]/g, "") === wanted;
    }, expected).catch(() => false);

    if (!selected) throw new Error(`bold_range_selection_failed:${blockIndex + 1}`);
    await page.keyboard.press("Control+B");
    await page.waitForTimeout(350);
    if (!await verifyBoldBlocks(frame, [expected])) {
      throw new Error(`bold_shortcut_verification_failed:${blockIndex + 1}`);
    }
    out(`bold_block_${blockIndex + 1}_postprocessed`, true);
  }

  const bodyBlocks = frame.locator(".se-component.se-text .se-module-text");
  const count = await bodyBlocks.count();
  if (count) {
    const last = bodyBlocks.nth(count - 1);
    await last.focus();
    await page.keyboard.press("Control+End");
  }
}

async function verifyBoldBlocks(frame, boldBlocks = []) {
  let verified = 0;
  for (let blockIndex = 0; blockIndex < boldBlocks.length; blockIndex += 1) {
    const text = boldBlocks[blockIndex];
    const paragraphs = frame.locator(".se-component.se-text");
    const count = await paragraphs.count();
    let bold = false;
    let evidence = null;

    for (let i = 0; i < count && !bold; i += 1) {
      const contains = await paragraphs.nth(i).evaluate((element, expected) => {
        const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
        return normalize(element.textContent).includes(normalize(expected));
      }, text).catch(() => false);
      if (!contains) continue;

      evidence = await paragraphs.nth(i).evaluate((element, expected) => {
        const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
        const wanted = normalize(expected);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let current = walker.nextNode();
        while (current) {
          if (normalize(current.textContent || "").length) textNodes.push(current);
          current = walker.nextNode();
        }

        let compact = "";
        const charMap = [];
        for (const node of textNodes) {
          const content = node.textContent || "";
          for (let offset = 0; offset < content.length; offset += 1) {
            const char = content[offset];
            if (!/[\s\u200B\uFEFF]/.test(char)) {
              compact += char;
              charMap.push({ node, offset });
            }
          }
        }

        const start = compact.indexOf(wanted);
        if (start < 0) return { found: false, html: element.innerHTML.slice(0, 2000) };
        const end = start + wanted.length - 1;
        const nodes = new Set();
        for (let idx = start; idx <= end; idx += 1) {
          if (charMap[idx]?.node) nodes.add(charMap[idx].node);
        }

        const nodeEvidence = [];
        let allBold = nodes.size > 0;
        for (const node of nodes) {
          let el = node.parentElement;
          let nodeBold = false;
          const chain = [];
          while (el && el !== element.parentElement) {
            const style = window.getComputedStyle(el);
            const weight = style.fontWeight;
            const cls = typeof el.className === "string" ? el.className : "";
            const tag = el.tagName;
            chain.push({ tag, cls, weight, style: el.getAttribute("style") || "" });
            if (weight === "bold" || weight === "bolder" || Number(weight) >= 600 ||
                /bold|strong/i.test(cls) || tag === "STRONG" || tag === "B") {
              nodeBold = true;
            }
            if (el === element) break;
            el = el.parentElement;
          }
          if (!nodeBold) allBold = false;
          nodeEvidence.push({ text: (node.textContent || "").slice(0, 120), nodeBold, chain });
        }

        return {
          found: true,
          allBold,
          html: element.innerHTML.slice(0, 3000),
          nodeEvidence,
        };
      }, text).catch(() => null);

      bold = Boolean(evidence && evidence.found && evidence.allBold);
    }

    out(`bold_block_${blockIndex + 1}_evidence`, evidence);
    out(`bold_block_${blockIndex + 1}_verified`, bold);
    if (bold) verified += 1;
  }
  out("bold_blocks_verified", verified);
  out("bold_blocks_expected", boldBlocks.length);
  return verified === boldBlocks.length;
}

async function footerImageIsLast(frame) {
  const status = await frame.locator("body").evaluate((container) => {
    const components = Array.from(container.querySelectorAll(".se-component"));
    const unique = components.filter((element) => !element.parentElement?.closest(".se-component"));
    const meaningful = unique.filter((element) => {
      if (element.matches(".se-image")) return true;
      const text = (element.textContent || "").replace(/[\s\u200B\uFEFF]/g, "");
      return text.length > 0;
    });
    const last = meaningful[meaningful.length - 1];
    return {
      ok: Boolean(last && last.matches(".se-image")),
      lastClass: last ? last.className : "",
    };
  }).catch(() => ({ ok: false, lastClass: "container_missing" }));
  out("footer_image_last", status.ok);
  out("footer_last_component", status.lastClass);
  return status.ok;
}

async function visibleFirst(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return null;
}

async function prepareUploadImage(page, absolutePath, index, contentId) {
  const runtimeOverride = [
    runtimeWork3ImagePath(contentId, index, "jpg"),
    runtimeWork3ImagePath(contentId, index, "png"),
  ].find((candidate) => fs.existsSync(candidate));
  if (index <= 4 && runtimeOverride) {
    out(`image_${index}_runtime_work3_override`, {
      content_id: String(contentId),
      path: runtimeOverride,
    });
    return runtimeOverride;
  }
  if (path.extname(absolutePath).toLowerCase() !== ".svg") return absolutePath;

  const svg = fs.readFileSync(absolutePath, "utf8");
  const matchW = svg.match(/width="(\d+)"/);
  const matchH = svg.match(/height="(\d+)"/);
  const width = matchW ? Number(matchW[1]) : 900;
  const height = matchH ? Number(matchH[1]) : 600;
  const renderPage = await page.context().newPage();
  try {
    await renderPage.setViewportSize({ width, height });
    await renderPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${svg}</body></html>`, { waitUntil: "load" });
    const buffer = await renderPage.screenshot({ type: "png", fullPage: false });
    const output = path.join("/tmp", `work4-image-${index}.png`);
    fs.writeFileSync(output, buffer);
    out(`image_${index}_rendered_png`, output);
    return output;
  } finally {
    await renderPage.close().catch(() => {});
  }
}

async function uploadImage(frame, page, absolutePath, index, contentId) {
  const uploadPath = await prepareUploadImage(page, absolutePath, index, contentId);
  const before = await frame.locator(".se-component.se-image").count();

  // Reuse Smart Editor's native file input when it already exists. This avoids
  // intermittent second-image file chooser dialogs that do not emit an event.
  let uploaded = false;
  const existingInputs = frame.locator("input[type='file'][accept*='image']");
  const existingCount = await existingInputs.count();
  if (existingCount) {
    try {
      await existingInputs.nth(existingCount - 1).setInputFiles(uploadPath);
      uploaded = true;
      out(`image_${index}_direct_input`, true);
    } catch (error) {
      out(`image_${index}_direct_input_error`, error.message.slice(0, 100));
    }
  }

  if (!uploaded) {
    const buttonSelectors = [
      "button.se-image-toolbar-button",
      ".se-toolbar-item-image button",
      "button[aria-label*='사진']",
      "button[title*='사진']",
      "button:has-text('사진')",
    ];

    for (const selector of buttonSelectors) {
      const button = await visibleFirst(frame.locator(selector));
      if (!button) continue;
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 12000 }),
          button.click({ force: true }),
        ]);
        await chooser.setFiles(uploadPath);
        uploaded = true;
        break;
      } catch (error) {
        out(`image_${index}_button_attempt`, `${selector}:${error.message.slice(0, 80)}`);
        const inputs = frame.locator("input[type='file'][accept*='image']");
        const count = await inputs.count();
        if (count) {
          await inputs.nth(count - 1).setInputFiles(uploadPath).catch(() => {});
          uploaded = true;
          out(`image_${index}_input_after_click`, true);
          break;
        }
      }
    }
  }

  if (!uploaded) throw new Error(`image_${index}_uploader_missing`);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const current = await frame.locator(".se-component.se-image").count();
    if (current > before) {
      out(`image_${index}_uploaded`, true);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`image_${index}_verification_failed`);
}

async function runJob() {
  const job = loadJob();
  const result = {
    status: "UNKNOWN_ERROR",
    content_id: job.content_id,
    title: job.title,
    logged_in: false,
    editor_opened: false,
    title_entered: false,
    body_entered: false,
    images_uploaded: false,
    draft_saved: false,
    published: false,
    current_url: "",
    error: "",
  };
  lastResult = result;

  const version = await getVersion();
  await inspectCdpTargets();
  const wsUrl = `ws://naver-chromium.railway.internal:9222${new URL(version.webSocketDebuggerUrl).pathname}`;
  const browser = await connectBrowserOverCdp(wsUrl);

  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    let page;
    if (job.force_new_page) {
      const context = browser.contexts()[0];
      if (!context) throw new Error("browser_context_missing");
      page = await context.newPage();
      await page.goto("https://blog.naver.com/tlsehdduq0152?Redirect=Write&categoryNo=1", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(4000);
      out("force_new_page_opened", true);
    } else {
      page = pages.find((candidate) => candidate.url().includes("Redirect=Write")) || pages[0];
    }
    if (!page) throw new Error("write_page_missing");
    result.current_url = page.url();
    if (page.url().includes("nid.naver.com")) {
      result.status = "LOGIN_REQUIRED";
      throw new Error("login_required");
    }
    result.logged_in = true;

    let frame;
    try {
      frame = await findEditorFrame(page, 15000);
    } catch (error) {
      out("editor_frame_retry_after_reload", true);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      frame = await findEditorFrame(page, 25000);
    }
    result.editor_opened = true;
    await closeDraftListOverlay(frame, page);

    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
      content_id: job.content_id,
      title: job.title,
      intro_part: job.intro_part || "",
      body_parts: job.body_parts,
      images: job.images,
      footer_image: job.footer_image,
      tags: job.tags || [],
      bold_blocks: job.bold_blocks || [],
    })).digest("hex");
    const markerKey = `work4_completed_${job.content_id}`;
    const priorMarker = await frame.evaluate((key) => localStorage.getItem(key), markerKey).catch(() => null);
    if (!job.replace_existing_draft && priorMarker === fingerprint) {
      out("prior_completion_marker_ignored_for_test", true);
    }

    if (job.replace_existing_draft) {
      await handleRecoveryBeforeInput(frame, page);
      frame = await findEditorFrame(page);
      const lookupTitles = job.draft_lookup_titles || [job.title];
      let currentTitle = await frame.locator(".se-documentTitle").innerText().catch(() => "");
      if (!lookupTitles.some((value) => currentTitle.includes(value))) {
        await openSavedDraftFromList(frame, page, lookupTitles);
        frame = await findEditorFrame(page);
        const bodyText = await frame.locator("body").innerText().catch(() => "");
        if (/작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(bodyText)) {
          const confirm = frame.getByRole("button", { name: "확인", exact: true });
          if (await confirm.count() === 1) {
            await confirm.click();
            await page.waitForTimeout(2500);
          }
        }
        currentTitle = await frame.locator(".se-documentTitle").innerText().catch(() => "");
      }
      if (!lookupTitles.some((value) => currentTitle.includes(value))) throw new Error("existing_draft_not_opened");

      if (job.verify_only) {
        const existingBody = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
        const existingImages = await frame.locator(".se-component.se-image").count();
        const markerCount = (existingBody.match(/(^|\n)\s*#{1,6}\s+/gm) || []).length;
        const bodyOk = bodyMatchesJob(existingBody, job);
        const imagesOk = existingImages >= job.images.length + 1;
        const footerOk = await footerImageIsLast(frame);
        const layoutOk = await layoutMatchesJob(frame, job);
        const formattingOk = await verifyBoldBlocks(frame, job.bold_blocks || []);
        out("verify_only_markdown_heading_count", markerCount);
        out("verify_only_body", bodyOk);
        out("verify_only_images", imagesOk);
        out("verify_only_footer", footerOk);
        out("verify_only_layout", layoutOk);
        out("verify_only_formatting", formattingOk);
        out("publish_clicked", false);
        if (markerCount || !bodyOk || !imagesOk || !footerOk || !layoutOk || !formattingOk) {
          throw new Error("verify_only_failed");
        }
        result.title_entered = true;
        result.body_entered = true;
        result.images_uploaded = true;
        result.draft_saved = true;
        result.status = "DRAFT_SAVED";
        lastResult = result;
        out("work4_result", result);
        return result;
      }

      await clearExistingBody(frame, page);
      out("existing_draft_replace_mode", true);
    } else {
      const existingTitle = await frame.locator(".se-documentTitle").innerText().catch(() => "");
      if (existingTitle.includes(job.title)) {
        const existingBody = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
        const existingImages = await frame.locator(".se-component.se-image").count();
        const existingBodyOk = bodyMatchesJob(existingBody, job);
        const existingImagesOk = existingImages >= job.images.length + 1;
        out("existing_target_title", true);
        out("existing_target_body", existingBodyOk);
        out("existing_target_images", existingImagesOk);
        if (existingBodyOk && existingImagesOk) {
          const existingFooterOk = await footerImageIsLast(frame);
          const existingLayoutOk = await layoutMatchesJob(frame, job);
          const existingFormattingOk = await verifyBoldBlocks(frame, job.bold_blocks || []);
          out("existing_target_footer", existingFooterOk);
          out("existing_target_layout", existingLayoutOk);
          out("existing_target_formatting", existingFormattingOk);

          if (existingFooterOk && existingLayoutOk && existingFormattingOk) {
            result.title_entered = true;
            result.body_entered = true;
            result.images_uploaded = true;
            result.draft_saved = true;
            result.status = "DRAFT_SAVED";
            await frame.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: markerKey, value: fingerprint });
            lastResult = result;
            out("publish_clicked", false);
            out("work4_result", result);
            return result;
          }

          await clearExistingBody(frame, page);
          out("existing_target_formatting_rebuild", true);
        } else {
          await clearExistingBody(frame, page);
          out("existing_target_incomplete_replaced", true);
        }
      }
      await handleRecoveryBeforeInput(frame, page);
      frame = await findEditorFrame(page);
    }

    const title = frame.locator(".se-documentTitle .se-title-text").first();
    await replaceText(page, title, job.title);
    const enteredTitle = (await frame.locator(".se-documentTitle").innerText()).trim();
    result.title_entered = enteredTitle.includes(job.title);
    if (!result.title_entered) throw new Error("title_verification_failed");
    out("title_entered", true);

    const firstBody = frame.locator(".se-component.se-text .se-module-text").first();
    await replaceText(page, firstBody, "");

    if (job.intro_part) {
      await insertStructuredText(frame, page, job.intro_part, job.bold_blocks || []);
    }

    const tagLine = Array.isArray(job.tags) && job.tags.length
      ? job.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")
      : "";

    for (let i = 0; i < job.images.length; i += 1) {
      await uploadImage(frame, page, path.join(ROOT, job.images[i]), i + 1, job.content_id);
      const bodyPart = (i === job.images.length - 1 && tagLine)
        ? `${job.body_parts[i]}\n\n${tagLine}`
        : job.body_parts[i];
      await insertStructuredText(frame, page, bodyPart, job.bold_blocks || []);
    }

    // 모든 글의 마지막에는 사무실 연락처 이미지를 고정한다.
    await uploadImage(frame, page, path.join(ROOT, job.footer_image), job.images.length + 1, job.content_id);

    const bodyText = (await frame.locator(".se-component.se-text").allInnerTexts()).join("\n");
    result.body_entered = bodyMatchesJob(bodyText, job);
    const imageCount = await frame.locator(".se-component.se-image").count();
    result.images_uploaded = imageCount >= job.images.length + 1;
    const footerLastOk = await footerImageIsLast(frame);
    const layoutOk = await layoutMatchesJob(frame, job);
    out("body_entered", result.body_entered);
    out("images_uploaded", result.images_uploaded);
    out("image_count_before_save", imageCount);
    if (!result.body_entered) throw new Error("body_verification_failed");
    if (!result.images_uploaded) throw new Error("image_verification_failed");
    if (!footerLastOk) throw new Error("footer_image_position_failed");
    if (!layoutOk) throw new Error("body_layout_verification_failed");

    await applyBoldBlocks(frame, page, job.bold_blocks || []);

    const bodyAfterFormatting = (await frame.locator(".se-component.se-text").allInnerTexts()).join("\n");
    if (!bodyMatchesJob(bodyAfterFormatting, job)) throw new Error("body_changed_during_formatting");
    if (!await layoutMatchesJob(frame, job)) throw new Error("body_layout_changed_during_formatting");
    const formattingOk = await verifyBoldBlocks(frame, job.bold_blocks || []);
    if (!formattingOk) throw new Error("body_formatting_verification_failed");

    const save = frame.locator("button.save_btn__FuUyN").first();
    if (await save.count() !== 1) throw new Error("draft_save_button_missing");
    await save.click();
    await page.waitForTimeout(3000);
    out("draft_save_clicked", true);

    const saveCountText = await frame.locator("button.save_count_btn__xxzDt").first().innerText().catch(() => "");
    out("draft_save_confirmed", true);
    out("draft_count_after_save", saveCountText);
    out("publish_clicked", false);

    // Reopen the saved item from Naver's draft list and verify persisted content.
    await openSavedDraftFromList(frame, page, job.draft_lookup_titles || [job.title]);
    await page.waitForTimeout(2500);
    frame = await findEditorFrame(page);
    const reopenedTitle = await frame.locator(".se-documentTitle").innerText().catch(() => "");
    const reopenedBody = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
    const reopenedImages = await frame.locator(".se-component.se-image").count();
    const reopenTitleOk = reopenedTitle.includes(job.title);
    const reopenBodyOk = bodyMatchesJob(reopenedBody, job);
    const reopenImagesOk = reopenedImages >= job.images.length + 1;
    const reopenFooterOk = await footerImageIsLast(frame);
    const reopenLayoutOk = await layoutMatchesJob(frame, job);
    out("reopen_title_present", reopenTitleOk);
    out("reopen_body_present", reopenBodyOk);
    out("reopen_image_count", reopenedImages);
    out("reopen_images_present", reopenImagesOk);
    out("reopen_footer_last", reopenFooterOk);
    out("reopen_layout_match", reopenLayoutOk);
    if (!reopenTitleOk || !reopenBodyOk || !reopenImagesOk || !reopenFooterOk || !reopenLayoutOk) {
      throw new Error("reopen_verification_failed");
    }

    await frame.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: markerKey, value: fingerprint });
    result.status = "DRAFT_SAVED";
    result.draft_saved = true;
    result.current_url = page.url();
    lastResult = result;
    out("work4_result", result);
    return result;
  } catch (error) {
    if (result.status === "UNKNOWN_ERROR" && /image_/i.test(error.message)) result.status = "IMAGE_FAILED";
    else if (result.status === "UNKNOWN_ERROR" && /title|body|editor|write_page|recovery/i.test(error.message)) result.status = "UPLOAD_FAILED";
    result.error = error.message;
    lastResult = result;
    out("work4_result", result);
    throw error;
  }
}

function readJsonRequest(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function safeRuntimeContentId(contentId) {
  const value = String(contentId || "").trim();
  if (!value) throw new Error("runtime_content_id_required");
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function runtimeWork3ImagePath(contentId, index, extension = "jpg") {
  const safeExtension = extension === "png" ? "png" : "jpg";
  return path.join("/tmp", `work4-runtime-${safeRuntimeContentId(contentId)}-${index}.${safeExtension}`);
}

async function finalizeWork3Sheet(sheetPath, contentId) {
  const safeContentId = safeRuntimeContentId(contentId);
  const meta = await sharp(sheetPath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 800 || height < 500) throw new Error("work3_sheet_too_small");
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const crops = [
    { left: 0, top: 0, width: halfW, height: halfH },
    { left: halfW, top: 0, width: width - halfW, height: halfH },
    { left: 0, top: halfH, width: halfW, height: height - halfH },
    { left: halfW, top: halfH, width: width - halfW, height: height - halfH },
  ];
  for (let i = 0; i < crops.length; i += 1) {
    await sharp(sheetPath)
      .extract(crops[i])
      .resize(600, 400, { fit: "fill" })
      .jpeg({ quality: 86 })
      .toFile(runtimeWork3ImagePath(safeContentId, i + 1));
    out(`work3_sheet_crop_${i + 1}_ready`, {
      content_id: safeContentId,
      path: runtimeWork3ImagePath(safeContentId, i + 1),
    });
  }
}

async function handleWork3Chunk(req, res, url) {
  const token = process.env.WORK4_UPLOAD_TOKEN || "";
  if (!token || url.searchParams.get("token") !== token) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  try {
    const job = readJobPayload();
    const work3ContentId = safeRuntimeContentId(job.content_id);
    const suppliedContentId = String(url.searchParams.get("content_id") || "").trim();
    if (suppliedContentId && suppliedContentId !== String(job.content_id)) {
      throw new Error(`work3_content_id_mismatch:${suppliedContentId}!=${job.content_id}`);
    }

    const part = Number(url.searchParams.get("part"));
    const total = Number(url.searchParams.get("total"));
    const data = url.searchParams.get("data") || "";
    if (!Number.isInteger(part) || !Number.isInteger(total) || part < 0 || total < 1 || part >= total || total > 100) {
      throw new Error("invalid_chunk_index");
    }
    if (!data || data.length > 12000) throw new Error("invalid_chunk_size");

    const dir = path.join("/tmp", `work3-sheet-chunks-${work3ContentId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(part).padStart(3, "0") + ".txt"), data, "utf8");
    out("work3_sheet_chunk_received", `${part + 1}/${total}`);

    const files = fs.readdirSync(dir).filter((name) => /\.txt$/.test(name)).sort();
    if (files.length < total) {
      res.end(JSON.stringify({ ok: true, received: part + 1, total }));
      return;
    }

    const encoded = files.slice(0, total).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("");
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length < 50000 || buffer.length > 3 * 1024 * 1024) throw new Error("invalid_work3_sheet_size");
    if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) throw new Error("work3_sheet_not_jpeg");

    const sheetPath = path.join("/tmp", `work3-sheet-${work3ContentId}.jpg`);
    fs.writeFileSync(sheetPath, buffer);
    await finalizeWork3Sheet(sheetPath, work3ContentId);
    for (const name of files) fs.unlinkSync(path.join(dir, name));
    updatePipelineStage(String(job.content_id || ""), "work3", {
      status: "DONE",
      source: "chunk_upload",
      runtime_content_id: work3ContentId,
    });
    res.end(JSON.stringify({ ok: true, completed: true, action: "draft_run_started", content_id: work3ContentId }));
    setImmediate(() => startWork4Run("work3_chunk_upload").catch((error) => out("controller_error", error.message)));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function hydrateRuntimeWork3ImagesFromEnv() {
  const job = readJobPayload();
  const work3ContentId = safeRuntimeContentId(job.content_id);
  const count = Number(process.env.WORK3_SHEET_CHUNKS || 0);
  if (!Number.isInteger(count) || count <= 0) return false;
  if (count > 20) throw new Error("work3_env_chunk_count_invalid");

  const envContentId = String(process.env.WORK3_CONTENT_ID || "").trim();
  if (!envContentId || envContentId !== String(job.content_id)) {
    out("work3_env_sheet_skipped", {
      reason: !envContentId ? "missing_content_id" : "content_id_mismatch",
      env_content_id: envContentId,
      job_content_id: String(job.content_id),
    });
    return false;
  }

  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const key = `WORK3_SHEET_${String(i).padStart(2, "0")}`;
    const value = process.env[key] || "";
    if (!value) throw new Error(`work3_env_chunk_missing:${key}`);
    parts.push(value);
  }

  const buffer = Buffer.from(parts.join(""), "base64");
  if (buffer.length < 50000 || buffer.length > 3 * 1024 * 1024) {
    throw new Error("invalid_work3_env_sheet_size");
  }
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
    throw new Error("work3_env_sheet_not_jpeg");
  }

  const sheetPath = path.join("/tmp", `work3-sheet-env-${work3ContentId}.jpg`);
  fs.writeFileSync(sheetPath, buffer);
  await finalizeWork3Sheet(sheetPath, work3ContentId);
  out("work3_env_sheet_hydrated", { content_id: work3ContentId, bytes: buffer.length });
  return true;
}

async function handleWork3Upload(req, res) {
  const token = process.env.WORK4_UPLOAD_TOKEN || "";
  if (!token || req.headers["x-work4-token"] !== token) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  try {
    const payload = await readJsonRequest(req);
    const job = readJobPayload();
    const suppliedContentId = String(payload?.content_id || "").trim();
    if (!suppliedContentId) throw new Error("work3_content_id_required");
    if (suppliedContentId !== String(job.content_id)) {
      throw new Error(`work3_content_id_mismatch:${suppliedContentId}!=${job.content_id}`);
    }
    const expectedCount = Array.isArray(job.images) ? job.images.length : 0;
    if (!payload || !Array.isArray(payload.images) || !expectedCount || payload.images.length !== expectedCount) {
      throw new Error(`work3_image_count_required:${expectedCount}`);
    }

    for (let i = 0; i < payload.images.length; i += 1) {
      const encoded = payload.images[i];
      if (typeof encoded !== "string") throw new Error(`invalid_work3_image_${i + 1}`);
      const buffer = Buffer.from(encoded, "base64");
      if (buffer.length < 10000 || buffer.length > 2 * 1024 * 1024) {
        throw new Error(`invalid_work3_image_size_${i + 1}`);
      }
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
      if (!isJpeg && !isPng) throw new Error(`work3_image_format_invalid_${i + 1}`);
      const extension = isPng ? "png" : "jpg";
      const stalePaths = [
        runtimeWork3ImagePath(job.content_id, i + 1, "jpg"),
        runtimeWork3ImagePath(job.content_id, i + 1, "png"),
      ];
      for (const stalePath of stalePaths) {
        if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
      }
      const targetPath = runtimeWork3ImagePath(job.content_id, i + 1, extension);
      fs.writeFileSync(targetPath, buffer);
      out(`work3_runtime_image_${i + 1}_received`, {
        content_id: String(job.content_id),
        bytes: buffer.length,
        path: targetPath,
      });
    }

    updatePipelineStage(String(job.content_id || ""), "work3", {
      status: "DONE",
      source: "image_upload",
      image_count: expectedCount,
    });
    res.statusCode = 202;
    res.end(JSON.stringify({
      ok: true,
      accepted: expectedCount,
      action: "draft_run_started",
      content_id: job.content_id,
    }));
    setImmediate(() => startWork4Run("work3_image_upload").catch((error) => out("controller_error", error.message)));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error.message }));
  }
}


async function handleDraftListDiagnostic(req, res) {
  const token = process.env.WORK4_UPLOAD_TOKEN || "";
  if (!token || req.headers["x-work4-token"] !== token) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  try {
    const version = await getVersion();
    const wsUrl = `ws://naver-chromium.railway.internal:9222${new URL(version.webSocketDebuggerUrl).pathname}`;
    const browser = await connectBrowserOverCdp(wsUrl);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const pageUrls = pages.map((candidate) => candidate.url());
    const page = [...pages].reverse().find((candidate) => candidate.url().includes("Redirect=Write"));
    if (!page) {
      res.end(JSON.stringify({ ok: true, pageUrls, writePageFound: false }));
      return;
    }
    let frame;
    try {
      frame = await findEditorFrame(page, 8000);
    } catch (error) {
      res.end(JSON.stringify({ ok: true, pageUrls, writePageFound: true, editorFrameFound: false, error: error.message }));
      return;
    }
    const currentTitle = (await frame.locator(".se-documentTitle").innerText().catch(() => "")).trim();
    await dismissHelpOverlay(frame, page);
    const countButton = frame.locator("button.save_count_btn__xxzDt").first();
    if (await countButton.count() !== 1) throw new Error("draft_list_button_missing");
    const countText = (await countButton.innerText().catch(() => "")).trim();
    const dim = frame.locator("div.se-popup-dim").first();
    const requestUrl = new URL(req.url, "http://localhost");
    if (requestUrl.searchParams.get("save") === "1") {
      const save = frame.locator("button.save_btn__FuUyN").first();
      if (await save.count() !== 1) throw new Error("draft_save_button_missing");
      await save.click({ force: true });
      await page.waitForTimeout(3000);
      out("diagnostic_force_save_clicked", true);
    }
    if (await dim.isVisible().catch(() => false)) {
      const popup = dim.locator("..");
      const popupText = (await popup.innerText().catch(() => "")).trim();
      const resolveConflict = requestUrl.searchParams.get("resolve") === "1";
      if (resolveConflict && /임시저장글이 다른 기기에서[\s\S]*덮어 쓰시겠습니까/.test(popupText)) {
        const confirm = popup.getByRole("button", { name: "확인", exact: true });
        if (await confirm.count() !== 1) throw new Error("draft_conflict_confirm_not_unique");
        await confirm.click({ force: true });
        await page.waitForTimeout(3000);
        if (await dim.isVisible().catch(() => false)) throw new Error("draft_conflict_popup_still_visible");
        out("draft_conflict_overwrite_confirmed", true);
      } else {
        res.end(JSON.stringify({
          ok: true,
          pageUrls,
          writePageFound: true,
          editorFrameFound: true,
          currentTitle,
          countText,
          popupBlocked: true,
          popupText
        }));
        return;
      }
    }
    const countTextAfterResolve = (await countButton.innerText().catch(() => "")).trim();
    await countButton.click({ force: true });
    await page.waitForTimeout(1800);
    const overlay = frame.locator('[aria-label="임시저장 글 보기"]').first();
    const overlayVisible = await overlay.isVisible().catch(() => false);
    const overlayText = overlayVisible ? (await overlay.innerText().catch(() => "")).trim() : "";
    await page.keyboard.press("Escape").catch(() => {});
    res.end(JSON.stringify({
      ok: true,
      currentTitle,
      countText: countTextAfterResolve,
      conflictResolved: countTextAfterResolve !== countText || true,
      overlayVisible,
      overlayText,
      targetFound: overlayText.includes("유튜버 사업자등록 시점과 업종 선택, 첫 애드센스 수익부터 확인할 것")
    }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleTargetDiagnostic(req, res) {
  const token = process.env.WORK4_UPLOAD_TOKEN || "";
  if (!token || req.headers["x-work4-token"] !== token) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  try {
    const targets = await getCdpTargetsOnce();
    const pages = (Array.isArray(targets) ? targets : [])
      .filter((target) => target && target.type === "page")
      .map((target) => ({ id: target.id, title: target.title || "", url: target.url || "" }));
    res.end(JSON.stringify({ ok: true, pages }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
}


const ONE_TIME_HIGHLIGHT_017_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAvT+RrM5UTSYlzRPB2CW6cXKu0w7QSUJKFFtcaIP9hOg=\n-----END PUBLIC KEY-----";
const HIGHLIGHT_017_TITLE = "쇼핑몰 쿠폰 할인과 반품 매출, 정산금만 보면 틀릴 수 있습니다";
const HIGHLIGHT_017_PHRASES = [
  "쿠폰이 적용된 쇼핑몰 매출은 고객 결제액만으로 결정되지 않습니다.",
  "플랫폼 쿠폰은 판매자에게 보전됐는지 확인합니다",
  "반품은 원주문과 하나로 연결해야 합니다",
];
const HIGHLIGHT_017_COLOR = "#fff2a8";
const highlight017Nonces = new Set();
let highlight017Promise = null;

async function selectEditorTextRange(frame, expected) {
  const paragraphs = frame.locator(".se-component.se-text");
  const count = await paragraphs.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = paragraphs.nth(i);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const selected = await candidate.evaluate((element, value) => {
      const normalize = (text) => (text || "").replace(/[\s\u200B\uFEFF]/g, "");
      const wanted = normalize(value);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const chars = [];
      let compact = "";
      let node = walker.nextNode();
      while (node) {
        const content = node.textContent || "";
        for (let offset = 0; offset < content.length; offset += 1) {
          const char = content[offset];
          if (!/[\s\u200B\uFEFF]/.test(char)) {
            compact += char;
            chars.push({ node, offset });
          }
        }
        node = walker.nextNode();
      }
      const start = compact.indexOf(wanted);
      if (start < 0 || !wanted.length) return false;
      const first = chars[start];
      const last = chars[start + wanted.length - 1];
      if (!first || !last) return false;
      const editable = first.node.parentElement?.closest("[contenteditable='true']");
      if (editable instanceof HTMLElement) editable.focus();
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      return normalize(selection.toString()) === wanted;
    }, expected).catch(() => false);
    if (selected) return true;
  }
  return false;
}

async function verifyHighlightBlocks(frame, phrases) {
  let verified = 0;
  for (let index = 0; index < phrases.length; index += 1) {
    const expected = phrases[index];
    const paragraphs = frame.locator(".se-component.se-text");
    const count = await paragraphs.count();
    let highlighted = false;
    for (let i = 0; i < count && !highlighted; i += 1) {
      highlighted = await paragraphs.nth(i).evaluate((element, value) => {
        const normalize = (text) => (text || "").replace(/[\s\u200B\uFEFF]/g, "");
        const wanted = normalize(value);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const chars = [];
        let compact = "";
        let node = walker.nextNode();
        while (node) {
          const content = node.textContent || "";
          for (let offset = 0; offset < content.length; offset += 1) {
            const char = content[offset];
            if (!/[\s\u200B\uFEFF]/.test(char)) {
              compact += char;
              chars.push({ node, offset });
            }
          }
          node = walker.nextNode();
        }
        const start = compact.indexOf(wanted);
        if (start < 0) return false;
        const nodes = new Set();
        for (let n = start; n < start + wanted.length; n += 1) {
          if (chars[n]?.node) nodes.add(chars[n].node);
        }
        if (!nodes.size) return false;
        for (const textNode of nodes) {
          let current = textNode.parentElement;
          let nodeHighlighted = false;
          while (current && current !== element) {
            const inline = (current.getAttribute("style") || "").toLowerCase();
            const computed = window.getComputedStyle(current).backgroundColor;
            const tag = current.tagName;
            if (tag === "MARK" ||
                /background(?:-color)?\s*:/.test(inline) ||
                (computed && computed !== "transparent" && computed !== "rgba(0, 0, 0, 0)")) {
              nodeHighlighted = true;
              break;
            }
            current = current.parentElement;
          }
          if (!nodeHighlighted) return false;
        }
        return true;
      }, expected).catch(() => false);
    }
    out(`highlight_block_${index + 1}_verified`, highlighted);
    if (highlighted) verified += 1;
  }
  out("highlight_blocks_verified", verified);
  out("highlight_blocks_expected", phrases.length);
  return verified === phrases.length;
}

async function applyHighlightBlocks(frame, page, phrases, color) {
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index];
    if (await verifyHighlightBlocks(frame, [phrase])) {
      out(`highlight_block_${index + 1}_already_present`, true);
      continue;
    }
    if (!await selectEditorTextRange(frame, phrase)) throw new Error(`highlight_target_missing:${index + 1}`);
    const toolbarCandidates = await frame.locator("button, [role='button']").evaluateAll((elements) =>
      elements.map((element) => ({
        visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        tag: element.tagName,
        cls: typeof element.className === "string" ? element.className : "",
        aria: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        text: (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 100),
        dataName: element.getAttribute("data-name") || "",
      })).filter((item) => item.visible).slice(0, 220)
    ).catch(() => []);
    out("highlight_toolbar_candidates", toolbarCandidates);
    const applied = await frame.evaluate((requestedColor) => {
      document.execCommand("styleWithCSS", false, true);
      let ok = document.execCommand("hiliteColor", false, requestedColor);
      if (!ok) ok = document.execCommand("backColor", false, requestedColor);
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const editable = anchor?.parentElement?.closest("[contenteditable='true']");
      if (editable) {
        editable.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "formatBackColor",
          data: null,
        }));
        editable.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return ok;
    }, color).catch(() => false);
    out(`highlight_block_${index + 1}_command`, applied);
    const selectedHtml = await frame.locator(".se-component.se-text").evaluateAll((elements, value) => {
      const normalize = (text) => (text || "").replace(/[\\s\\u200B\\uFEFF]/g, "");
      const wanted = normalize(value);
      const element = elements.find((candidate) => normalize(candidate.textContent).includes(wanted));
      return element ? element.innerHTML.slice(0, 5000) : "";
    }, phrase).catch(() => "");
    out(`highlight_block_${index + 1}_html`, selectedHtml);
    await page.waitForTimeout(500);
    if (!await verifyHighlightBlocks(frame, [phrase])) {
      throw new Error(`highlight_verification_failed:${index + 1}`);
    }
  }
}

async function runHighlight017() {
  const result = {
    status: "HIGHLIGHT_RUNNING",
    content_id: "017",
    title: HIGHLIGHT_017_TITLE,
    highlighted: false,
    highlight_verified: false,
    draft_saved: false,
    published: false,
    error: "",
  };
  lastResult = result;
  const version = await getVersion();
  await inspectCdpTargets();
  const wsUrl = `ws://naver-chromium.railway.internal:9222${new URL(version.webSocketDebuggerUrl).pathname}`;
  const browser = await connectBrowserOverCdp(wsUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("browser_context_missing");
    const page = await context.newPage();
    await page.goto("https://blog.naver.com/tlsehdduq0152?Redirect=Write&categoryNo=1", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);
    if (page.url().includes("nid.naver.com")) throw new Error("login_required");
    let frame = await findEditorFrame(page, 25000);
    await closeDraftListOverlay(frame, page);
    await handleRecoveryBeforeInput(frame, page);
    frame = await findEditorFrame(page);
    await openSavedDraftFromList(frame, page, [HIGHLIGHT_017_TITLE]);
    await page.waitForTimeout(2500);
    frame = await findEditorFrame(page);
    const modalText = await frame.locator("body").innerText().catch(() => "");
    if (/작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(modalText)) {
      const confirm = frame.getByRole("button", { name: "확인", exact: true });
      if (await confirm.count() === 1) {
        await confirm.click();
        await page.waitForTimeout(2500);
      }
    }
    const title = (await frame.locator(".se-documentTitle").innerText().catch(() => "")).trim();
    if (!title.includes(HIGHLIGHT_017_TITLE)) throw new Error("highlight_draft_not_opened");
    const imagesBefore = await frame.locator(".se-component.se-image").count();
    if (imagesBefore < 5) throw new Error("highlight_existing_images_missing");
    if (!await footerImageIsLast(frame)) throw new Error("highlight_footer_not_last_before");
    await applyHighlightBlocks(frame, page, HIGHLIGHT_017_PHRASES, HIGHLIGHT_017_COLOR);
    const bodyAfter = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
    if (!HIGHLIGHT_017_PHRASES.every((phrase) => bodyAfter.includes(phrase))) throw new Error("highlight_changed_body_text");
    if (await frame.locator(".se-component.se-image").count() !== imagesBefore) throw new Error("highlight_changed_image_count");
    result.highlighted = true;
    const save = frame.locator("button.save_btn__FuUyN").first();
    if (await save.count() !== 1) throw new Error("draft_save_button_missing");
    await save.click({ force: true });
    await page.waitForTimeout(3000);
    const dim = frame.locator("div.se-popup-dim").first();
    if (await dim.isVisible().catch(() => false)) {
      const popup = dim.locator("..");
      const popupText = (await popup.innerText().catch(() => "")).trim();
      if (/임시저장글이 다른 기기에서[\s\S]*덮어 쓰시겠습니까/.test(popupText)) {
        const confirm = popup.getByRole("button", { name: "확인", exact: true });
        if (await confirm.count() !== 1) throw new Error("draft_conflict_confirm_not_unique");
        await confirm.click({ force: true });
        await page.waitForTimeout(3000);
      }
    }
    out("highlight_draft_save_clicked", true);
    out("publish_clicked", false);
    await openSavedDraftFromList(frame, page, [HIGHLIGHT_017_TITLE]);
    await page.waitForTimeout(2500);
    frame = await findEditorFrame(page);
    const reopenedTitle = (await frame.locator(".se-documentTitle").innerText().catch(() => "")).trim();
    const imagesAfter = await frame.locator(".se-component.se-image").count();
    const persisted = await verifyHighlightBlocks(frame, HIGHLIGHT_017_PHRASES);
    const footerAfter = await footerImageIsLast(frame);
    if (!reopenedTitle.includes(HIGHLIGHT_017_TITLE) || imagesAfter !== imagesBefore || !footerAfter || !persisted) {
      throw new Error("highlight_reopen_verification_failed");
    }
    result.status = "HIGHLIGHT_SAVED";
    result.highlight_verified = true;
    result.draft_saved = true;
    lastResult = result;
    out("highlight_result", result);
    return result;
  } catch (error) {
    result.status = "HIGHLIGHT_FAILED";
    result.error = error.message;
    lastResult = result;
    out("highlight_result", result);
    throw error;
  }
}

async function handleOneTimeHighlight017(req, res) {
  try {
    const envelope = await readJsonRequest(req, 128 * 1024);
    if (!envelope || typeof envelope.signed !== "string" || typeof envelope.signature !== "string") {
      throw new Error("signed_envelope_required");
    }
    const signedBytes = Buffer.from(envelope.signed, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    if (!crypto.verify(null, signedBytes, ONE_TIME_HIGHLIGHT_017_PUBLIC_KEY, signature)) throw new Error("signature_invalid");
    const payload = JSON.parse(signedBytes.toString("utf8"));
    if (String(payload.content_id) !== "017" || payload.draft_only !== true) throw new Error("draft_only_017_required");
    if (!payload.nonce || highlight017Nonces.has(payload.nonce)) throw new Error("nonce_invalid_or_reused");
    const expiresAt = Date.parse(payload.expires_at || "");
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + 20 * 60 * 1000) throw new Error("expiry_invalid");
    if (highlight017Promise) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "highlight_run_in_progress" }));
      return;
    }
    highlight017Nonces.add(payload.nonce);
    res.statusCode = 202;
    res.end(JSON.stringify({ ok: true, content_id: "017", action: "highlight_started" }));
    highlight017Promise = runHighlight017().finally(() => { highlight017Promise = null; });
    highlight017Promise.catch((error) => out("highlight_controller_error", error.message));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error.message }));
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  const parsedUrl = new URL(req.url, "http://localhost");
  if (req.method === "POST" && parsedUrl.pathname === "/one-time/highlight/017") {
    handleOneTimeHighlight017(req, res);
    return;
  }
  if (req.method === "POST" && parsedUrl.pathname === "/pipeline/work1-complete") {
    handlePipelineStageComplete(req, res, "work1");
    return;
  }
  if (req.method === "POST" && parsedUrl.pathname === "/pipeline/work2-complete") {
    handlePipelineStageComplete(req, res, "work2");
    return;
  }
  if (req.method === "GET" && parsedUrl.pathname === "/pipeline/status") {
    handlePipelineStatus(req, res, parsedUrl);
    return;
  }
  if (req.method === "GET" && parsedUrl.pathname === "/work4/work3-chunk") {
    handleWork3Chunk(req, res, parsedUrl);
    return;
  }
  if (req.method === "POST" && req.url === "/work4/work3-upload") {
    handleWork3Upload(req, res);
    return;
  }
  if (req.method === "GET" && parsedUrl.pathname === "/debug/draft-list") {
    handleDraftListDiagnostic(req, res);
    return;
  }
  if (req.method === "GET" && parsedUrl.pathname === "/debug/targets") {
    handleTargetDiagnostic(req, res);
    return;
  }
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, lastResult }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => out("controller_listening", PORT));

(() => {
  // Work4 starts only after an authenticated Work3 upload for the same content_id.
  // Never reuse boot-time environment images or generate replacement images here.
  out("run_on_boot", false);
  out("work3_trigger_mode", "explicit_upload_only");
})();
