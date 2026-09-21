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

async function findEditorFrame(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.url().includes("PostWriteForm.naver"));
    if (frame && await frame.locator(".se-documentTitle").count().catch(() => 0)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("editor_frame_missing");
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
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        if (selection.toString() !== value) return false;
        if (editable instanceof HTMLElement) {
          editable.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertLineBreak",
          }));
        }
        range.deleteContents();
        const lineBreak = document.createElement("br");
        range.insertNode(lineBreak);
        selection.removeAllRanges();
        const caret = document.createRange();
        caret.setStartAfter(lineBreak);
        caret.collapse(true);
        selection.addRange(caret);
        if (editable instanceof HTMLElement) {
          editable.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertLineBreak",
          }));
        }
        return !element.textContent.includes(value);
      }, marker).catch(() => false);
      if (selected) break;
    }
    if (!selected) throw new Error(`layout_marker_missing:${marker}`);
  }

  const bodyText = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
  const remaining = layoutMarkers.filter((marker) => bodyText.includes(marker));
  out("layout_markers_replaced", layoutMarkers.length - remaining.length);
  if (remaining.length) throw new Error(`layout_markers_remaining:${remaining.length}`);
}

async function insertStructuredText(frame, page, text, boldBlocks = [], layoutMarkers = []) {
  const bodyBlocks = frame.locator(".se-component.se-text .se-module-text");
  const count = await bodyBlocks.count();
  if (!count) throw new Error("body_text_block_missing");
  const target = bodyBlocks.nth(count - 1);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  // 이미지 사이의 원문을 한 번의 입력 이벤트로 넣어 네이버가 연속 Enter 중
  // 일부 문단을 다른 컴포넌트로 옮기거나 누락하는 현상을 막는다.
  const canonicalText = text
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s+/, "• "))
    .join("\n");
  const encodedText = encodeLayoutMarkers(canonicalText, layoutMarkers);

  const boldRanges = boldBlocks
    .map((value) => ({ value, start: encodedText.indexOf(value) }))
    .filter((range) => range.start >= 0)
    .sort((left, right) => left.start - right.start);

  let offset = 0;
  for (const range of boldRanges) {
    if (range.start < offset) throw new Error("overlapping_bold_blocks");
    const plain = encodedText.slice(offset, range.start);
    if (plain) {
      await setBoldToolbarState(frame, page, false);
      await target.focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText(plain);
    }
    await setBoldToolbarState(frame, page, true);
    await target.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(range.value);
    offset = range.start + range.value.length;
  }

  const tail = encodedText.slice(offset);
  if (tail) {
    await setBoldToolbarState(frame, page, false);
    await target.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(tail);
  }
  await setBoldToolbarState(frame, page, false);
  await page.waitForTimeout(500);
}

async function applyBoldBlocks(frame, page, boldBlocks = []) {
  for (let blockIndex = boldBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const expected = boldBlocks[blockIndex];
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
    await page.waitForTimeout(200);
    await setBoldToolbarState(frame, page, true);
    await page.waitForTimeout(200);
    out(`bold_block_${blockIndex + 1}_postprocessed`, true);
  }

  const bodyBlocks = frame.locator(".se-component.se-text .se-module-text");
  const count = await bodyBlocks.count();
  if (count) {
    const last = bodyBlocks.nth(count - 1);
    await last.focus();
    await page.keyboard.press("Control+End");
    await setBoldToolbarState(frame, page, false);
  }
}

async function verifyBoldBlocks(frame, boldBlocks = []) {
  let verified = 0;
  for (let blockIndex = 0; blockIndex < boldBlocks.length; blockIndex += 1) {
    const text = boldBlocks[blockIndex];
    const paragraphs = frame.locator(".se-component.se-text");
    const count = await paragraphs.count();
    let bold = false;
    for (let i = 0; i < count && !bold; i += 1) {
      const contains = await paragraphs.nth(i).evaluate((element, expected) => {
        const normalize = (value) => (value || "").replace(/[\s\u200B\uFEFF]/g, "");
        return normalize(element.textContent).includes(normalize(expected));
      }, text).catch(() => false);
      if (!contains) continue;
      bold = await paragraphs.nth(i).evaluate((element, expected) => {
        const content = (element.textContent || "").replace(/[\u200B\uFEFF]/g, "").trim();
        if (!content.includes(expected.trim())) return false;

        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let current = walker.nextNode();
        while (current) {
          if ((current.textContent || "").replace(/[\s\u200B\uFEFF]/g, "").length) {
            textNodes.push(current);
          }
          current = walker.nextNode();
        }
        if (!textNodes.length) return false;

        const normalize = (value) => value.replace(/[\s\u200B\uFEFF]/g, "");
        const boldText = textNodes
          .filter((node) => {
            const weight = window.getComputedStyle(node.parentElement).fontWeight;
            return weight === "bold" || weight === "bolder" || Number(weight) >= 600;
          })
          .map((node) => node.textContent || "")
          .join("");
        return normalize(boldText).includes(normalize(expected));
      }, text).catch(() => false);
    }
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

async function uploadImage(frame, page, absolutePath, index) {
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
      await chooser.setFiles(absolutePath);
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
    await fileInputs.nth(count - 1).setInputFiles(absolutePath);
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
  const wsUrl = `ws://naver-chromium.railway.internal:9222${new URL(version.webSocketDebuggerUrl).pathname}`;
  const browser = await chromium.connectOverCDP(wsUrl, {
    headers: { Host: "localhost:9222" },
    timeout: 10000,
  });

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

    let frame = await findEditorFrame(page);
    result.editor_opened = true;

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
      result.status = "ALREADY_DRAFT_SAVED";
      result.error = "duplicate_job_skipped";
      out("work4_result", result);
      lastResult = result;
      return result;
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
        throw new Error("existing_target_incomplete");
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

    const layoutMarkers = [];
    if (job.intro_part) {
      await insertStructuredText(frame, page, job.intro_part, job.bold_blocks || [], layoutMarkers);
    }

    for (let i = 0; i < job.images.length; i += 1) {
      await uploadImage(frame, page, path.join(ROOT, job.images[i]), i + 1);
      await insertStructuredText(frame, page, job.body_parts[i], job.bold_blocks || [], layoutMarkers);
    }

    if (Array.isArray(job.tags) && job.tags.length) {
      const tagLine = job.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
      await insertStructuredText(frame, page, `\n\n${tagLine}`, [], layoutMarkers);
    }

    // 모든 글의 마지막에는 사무실 연락처 이미지를 고정한다.
    await uploadImage(frame, page, path.join(ROOT, job.footer_image), job.images.length + 1);

    await replaceLayoutMarkers(frame, page, layoutMarkers);

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

    await page.reload({ waitUntil: "commit", timeout: 10000 }).catch((error) => out("reload_nonfatal", error.message.slice(0, 80)));
    await page.waitForTimeout(4000);
    frame = await findEditorFrame(page);
    const resumedByModal = await handleRecoveryAfterReload(frame, page);
    if (!resumedByModal) {
      await openSavedDraftFromList(frame, page, job.draft_lookup_titles || [job.title]);
      frame = await findEditorFrame(page);
      const bodyText = await frame.locator("body").innerText().catch(() => "");
      if (/작성 중인 글이 있습니다|이어서 작성하시겠습니까/.test(bodyText)) {
        const confirm = frame.getByRole("button", { name: "확인", exact: true });
        if (await confirm.count() === 1) {
          await confirm.click();
          await page.waitForTimeout(2500);
          out("draft_open_confirm_clicked", true);
        }
      }
    }

    const restoredTitle = await frame.locator(".se-documentTitle").innerText().catch(() => "");
    const restoredBody = (await frame.locator(".se-component.se-text").allInnerTexts().catch(() => [])).join("\n");
    const restoredImages = await frame.locator(".se-component.se-image").count();
    const titleOk = restoredTitle.includes(job.title);
    const bodyOk = bodyMatchesJob(restoredBody, job);
    const imagesOk = restoredImages >= job.images.length + 1;
    const restoredFooterLastOk = await footerImageIsLast(frame);
    const restoredLayoutOk = await layoutMatchesJob(frame, job);
    const restoredFormattingOk = await verifyBoldBlocks(frame, job.bold_blocks || []);
    out("reload_title_present", titleOk);
    out("reload_body_present", bodyOk);
    out("reload_image_count", restoredImages);
    out("reload_images_present", imagesOk);
    out("publish_clicked", false);
    if (!titleOk || !bodyOk || !imagesOk || !restoredFooterLastOk || !restoredLayoutOk || !restoredFormattingOk) throw new Error("reload_verification_failed");

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
