#!/usr/bin/env node
"use strict";

// Read-only configuration check. Never prints tokens, URLs, or credentials.
// Usage: node scripts/check_pipeline_config.js
const path = require("node:path");
const stateFile = path.resolve(process.env.PIPELINE_STATE_FILE || "/tmp/naver-work-pipeline-state.json");
const checks = [
  ["WORK2_TRIGGER_URL", "Work1 → Work2"],
  ["WORK3_TRIGGER_URL", "Work2 → Work3"],
];
const errors = [];
for (const [key, stage] of checks) {
  const value = process.env[key] || "";
  if (!value) {
    errors.push(stage + ": " + key + " is missing");
    continue;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(stage + ": " + key + " must use HTTP(S)");
    }
  } catch (_) {
    errors.push(stage + ": " + key + " is not a valid URL");
  }
}
if (stateFile === "/tmp" || stateFile.startsWith("/tmp/")) {
  errors.push("Pipeline state is in ephemeral /tmp; move PIPELINE_STATE_FILE to a mounted persistent volume");
}
console.log(JSON.stringify({
  ok: errors.length === 0,
  problems: errors,
  persistence_verified: false,
  note: "Even with a non-/tmp path, verify the Railway volume mount; this check cannot prove durable storage. Daily scheduler and actual Work1→4 runs require separate evidence.",
}, null, 2));
process.exitCode = errors.length ? 1 : 0;
