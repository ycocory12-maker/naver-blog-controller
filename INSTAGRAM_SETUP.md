# Instagram Automation (Railway)

This service is intentionally isolated from the Naver browser automation. It uses Meta's official Graph API and does not use browser automation, Selenium, Playwright, scraping, or unofficial Instagram endpoints.

## Implemented

- Instagram comment webhook verification (GET challenge)
- Webhook HMAC SHA-256 signature verification using X-Hub-Signature-256
- Duplicate comment protection
- Conservative comment classification
- Safe auto-reply mode for configured low-risk categories
- Review queue for tax questions, general questions, and failed replies
- Manual reply endpoint for reviewed comments
- Single-image and carousel publishing using the media-container -> media_publish flow
- Short-lived signed media URLs so Meta can fetch locally staged JPEG files
- Retry with exponential backoff for 429 and 5xx responses
- Publishing quota endpoint
- Dry-run comment simulator for setup testing without sending a real reply
- JSON action log and review state

## Why this design

Patterns copied from successful open-source Meta Graph API automations:

1. Verify webhook signatures before processing.
2. Return HTTP 200 to Meta quickly, then process asynchronously.
3. Deduplicate by Instagram comment ID.
4. Separate automatic low-risk replies from human-review replies.
5. Persist actions/review queue instead of relying only on console logs.
6. Retry only transient Graph API errors (429/5xx).
7. Use the official content publishing container flow.
8. Keep Instagram automation isolated from unrelated production browser automation.

## Railway service

Create a separate Railway service from this repository and use:

- Start command: node instagram-service.js
- Health check: /health
- Persistent volume mount: /data
- Public HTTPS domain: required for webhook callbacks and temporary signed image URLs

Recommended environment variables:

- INSTAGRAM_API_VERSION=v26.0
- INSTAGRAM_GRAPH_BASE_URL=https://graph.facebook.com
- INSTAGRAM_ACCESS_TOKEN=<Meta token>
- INSTAGRAM_ACCOUNT_ID=<professional Instagram account ID>
- META_APP_SECRET=<Meta app secret>
- INSTAGRAM_WEBHOOK_VERIFY_TOKEN=<random secret>
- INSTAGRAM_ADMIN_TOKEN=<random strong admin secret>
- INSTAGRAM_MEDIA_SIGNING_SECRET=<random strong signing secret>
- INSTAGRAM_PUBLIC_BASE_URL=https://<railway-domain>
- INSTAGRAM_STATE_DIR=/data/instagram
- INSTAGRAM_REPLY_MODE=review
- INSTAGRAM_AUTO_REPLY_CATEGORIES=thanks,consultation

Never commit tokens or app secrets to GitHub.

## Recommended rollout

Start with:

INSTAGRAM_REPLY_MODE=review

This receives comments and creates review items but posts no automatic reply.

Test classification:

POST /instagram/simulate-comment
Header: X-Instagram-Admin-Token: <admin token>
JSON:
{
  "text": "좋은 정보 감사합니다"
}

Then connect the Meta webhook:

Callback:
https://<railway-domain>/instagram/webhook

Subscribe to Instagram comments.

After real webhook delivery is confirmed, switch to:

INSTAGRAM_REPLY_MODE=safe_auto

The default automatic categories are only:

- thanks
- consultation

Tax questions, ambiguous questions, and general comments remain in the review queue by default.

## Review queue

GET /instagram/reviews
Header: X-Instagram-Admin-Token: <admin token>

Manual reply:

POST /instagram/reviews/<review-id>/reply
Header: X-Instagram-Admin-Token: <admin token>
JSON:
{
  "message": "확인 후 안내드리겠습니다."
}

## Publishing

POST /instagram/publish
Header: X-Instagram-Admin-Token: <admin token>

Single image:

{
  "caption": "게시물 본문",
  "images": [
    {
      "jpeg_base64": "<base64>",
      "alt_text": "이미지 설명"
    }
  ]
}

Carousel: send 2-10 image objects.

This implementation accepts JPEG input only. That is deliberate: it removes image-format ambiguity from the first production rollout. The service temporarily exposes each uploaded JPEG through a signed, expiring public URL so Meta can fetch it while creating the publishing container.

## Security

- Webhook requests are HMAC-verified with META_APP_SECRET.
- Admin APIs require INSTAGRAM_ADMIN_TOKEN.
- Temporary media URLs are HMAC-signed and expire.
- Secrets are environment variables only.
- The public status endpoint reports only whether secrets are configured, never their values.
- Automatic replies are opt-in and category-limited.

## Persistence

Mount a Railway volume at /data. Without a volume, the service can still run, but deduplication/review state may be lost after a redeploy or restart.

## Current API version

The service defaults to Graph API v26.0, but the version is environment-configurable so future Meta upgrades do not require code changes.
