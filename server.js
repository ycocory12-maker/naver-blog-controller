const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright-core");

const PORT = Number(process.env.PORT || 3000);
const RUN_ON_BOOT = process.env.RUN_ON_BOOT === "true";
const JOB_FILE = process.env.JOB_FILE || "jobs/001.json";
const ROOT = __dirname;

let lastResult = { status: "IDLE", published: false };

function out(key, value) {
  console.log(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJob() {
  const job = JSON.parse(fs.readFileSync(path.join(ROOT, JOB_FILE), "utf8"));
  if (!job.content_id || !job.title || !Array.isArray(job.body_parts) || !Array.isArray(job.images)) {
    throw new Error("invalid_job_payload");
  }
  if (job.publish_mode !== "draft_only") throw new Error("publish_mode_must_be_draft_only");
  if (job.images.length !== job.body_parts.length) throw new Error("image_body_mapping_mismatch");
  if (!job.footer_image) throw new Error("footer_image_required");
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      out("cdp_version_attempt", attempt);
      const value = await getVersionOnce();
      out("cdp_version_ok", true);
      return value;
    } catch (error) {
      out("cdp_version_error", error.message);
      if (attempt < 3) await sleep(1500);
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
  const bodyText = await frame.locator("body").innerText().catch(() => "");
  const visible = /작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(bodyText);
  out("recovery_modal_before_input", visible);
  if (!visible) return;

  // 다른 임시저장을 덮어쓰지 않도록 새 글 시작 쪽(취소)만 허용한다.
  const cancel = frame.getByRole("button", { name: "취소", exact: true });
  const count = await cancel.count();
  out("recovery_cancel_count", count);
  if (count !== 1) throw new Error("recovery_conflict_no_unique_cancel");
  await cancel.click();
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

async function openSavedDraftFromList(frame, page, titles) {
  const countButton = frame.locator("button.save_count_btn__xxzDt").first();
  if (await countButton.count() !== 1) throw new Error("draft_list_button_missing");
  const countText = (await countButton.innerText().catch(() => "")).trim();
  out("draft_count_after_save", countText);
  await countButton.click();
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
        await candidate.click();
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
        await candidate.click();
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
  const actualSections = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => []))
    .map((value) => normalizeLayout(value.replace("글감과 함께 나의 일상을 기록해보세요!", "")))
    .filter(Boolean);
  const expectedSections = [job.intro_part || "", ...(job.body_parts || [])]
    .filter(Boolean)
    .map(normalizeLayout);

  let actualIndex = 0;
  for (let expectedIndex = 0; expectedIndex < expectedSections.length; expectedIndex += 1) {
    const expected = expectedSections[expectedIndex];
    let found = false;
    while (actualIndex < actualSections.length) {
      if (actualSections[actualIndex] === expected) {
        found = true;
        actualIndex += 1;
        break;
      }
      actualIndex += 1;
    }
    if (!found) {
      out("layout_missing_section", expectedIndex + 1);
      out("layout_expected_preview", expected.slice(0, 240));
      out("layout_actual_sections", actualSections.map((value) => value.slice(0, 120)));
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
    await target.click({ position: { x: 10, y: 10 } });
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

  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s+/, "• "));

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].length) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(500);
}

async function applyBoldBlocks(frame, page, boldBlocks = []) {
  const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
  const boldButton = await visibleFirst(
    frame.locator(".se-toolbar-item-bold button, button.se-toolbar-button.se-toolbar-button-bold, button[aria-label*='굵게'], button[title*='굵게']")
  );
  if (!boldButton) throw new Error("bold_toolbar_missing");

  for (let blockIndex = boldBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const expected = boldBlocks[blockIndex];
    const wanted = normalize(expected);
    const paragraphs = frame.locator(".se-component.se-text .se-text-paragraph");
    const count = await paragraphs.count();
    let target = null;

    for (let i = 0; i < count; i += 1) {
      const candidate = paragraphs.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = await candidate.innerText().catch(() => "");
      if (normalize(text).includes(wanted)) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new Error(`bold_paragraph_missing:${blockIndex + 1}`);

    await target.scrollIntoViewIfNeeded();
    await target.click({ clickCount: 3, delay: 80 });
    await page.waitForTimeout(250);

    const blockSelected = await target.evaluate((element) =>
      element.classList.contains("se-is-text-paragraph-block-selected")
    ).catch(() => false);
    out(`bold_block_${blockIndex + 1}_block_selected`, blockSelected);

    if (!blockSelected) {
      await target.click({ clickCount: 2, delay: 100 });
      await page.waitForTimeout(200);
    }

    const selectedAfterRetry = await target.evaluate((element) =>
      element.classList.contains("se-is-text-paragraph-block-selected")
    ).catch(() => false);
    if (!blockSelected && !selectedAfterRetry) {
      throw new Error(`bold_block_selection_failed:${blockIndex + 1}`);
    }

    await boldButton.click();
    await page.waitForTimeout(450);

    const boldApplied = await verifyBoldBlocks(frame, [expected]);
    if (!boldApplied) throw new Error(`bold_block_toolbar_failed:${blockIndex + 1}`);
    out(`bold_block_${blockIndex + 1}_postprocessed`, true);
  }

  const bodyBlocks = frame.locator(".se-component.se-text .se-module-text");
  const count = await bodyBlocks.count();
  if (count) {
    const last = bodyBlocks.nth(count - 1);
    await last.click();
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

async function prepareUploadImage(page, absolutePath, index) {
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

async function uploadImage(frame, page, absolutePath, index) {
  const uploadPath = await prepareUploadImage(page, absolutePath, index);
  const before = await frame.locator(".se-component.se-image").count();

  // insertStructuredText가 남긴 현재 편집 커서를 유지해야 이미지가 정확한 토큰 위치에 들어간다.
  const buttonSelectors = [
    "button.se-image-toolbar-button",
    ".se-toolbar-item-image button",
    "button[aria-label*='사진']",
    "button[title*='사진']",
    "button:has-text('사진')",
  ];

  let uploaded = false;
  for (const selector of buttonSelectors) {
    const button = await visibleFirst(frame.locator(selector));
    if (!button) continue;
    try {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
      await button.click();
      const chooser = await chooserPromise;
      await chooser.setFiles(uploadPath);
      uploaded = true;
      break;
    } catch (error) {
      out(`image_${index}_button_attempt`, `${selector}:${error.message.slice(0, 80)}`);
    }
  }

  if (!uploaded) {
    const fileInputs = frame.locator("input[type='file'][accept*='image']");
    const count = await fileInputs.count();
    if (!count) throw new Error(`image_${index}_uploader_missing`);
    await fileInputs.nth(count - 1).setInputFiles(uploadPath);
  }

  const deadline = Date.now() + 30000;
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
    const page = pages.find((candidate) => candidate.url().includes("Redirect=Write")) || pages[0];
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

    for (let i = 0; i < job.images.length; i += 1) {
      await uploadImage(frame, page, path.join(ROOT, job.images[i]), i + 1);
      await insertStructuredText(frame, page, job.body_parts[i], job.bold_blocks || []);
    }

    if (Array.isArray(job.tags) && job.tags.length) {
      const tagLine = job.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
      await insertStructuredText(frame, page, `\n\n${tagLine}`, job.bold_blocks || []);
    }

    // 모든 글의 마지막에는 사무실 연락처 이미지를 고정한다.
    await uploadImage(frame, page, path.join(ROOT, job.footer_image), job.images.length + 1);

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

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, lastResult }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => out("controller_listening", PORT));

if (RUN_ON_BOOT) {
  runJob().catch((error) => out("controller_error", error.message));
} else {
  out("run_on_boot", false);
}
