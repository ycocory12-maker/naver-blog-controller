# Work4 Relay /runtime-status 연결 패치 — 2026-10-30

> **미배포 변경 제안**. 이 문서는 Railway Function을 수정하지 않았으며, 프로덕션 controller/Relay 변수·볼륨·네이버 임시저장에도 영향을 주지 않습니다.

## 1. 근거로 확인한 현재 구조

- GitHub `main`의 `server.js`(2026-10-24 반영, blob `99aaa90b51a0e97023431fe7831653f2aff05860`)에는 **이미** 인증된 `GET /work4/runtime-status` 및 `handleWork4RuntimeStatus()`가 존재합니다. 동일 기능을 다시 작성하지 마세요.
- Railway production `naver-controller-github`는 2026-10-14 배포(`c86f99eb-e229-43dc-a1e3-4da65b645735`)로 유지되어 이 새 route가 **운영 반영됐다는 증거가 없습니다**.
- Railway `work4-forward-relay`의 배포된 Function에는 `/runtime-status` 라우팅이 없습니다. 10/23~29 HTTP 로그에 `GET /runtime-status` 404 **16건** 확인.
- 현재 Relay의 프록시 코드는 `x-work4-token`을 `TARGET_TOKEN` 값으로 설정하여 controller로 전달합니다. `main`의 `/work4/runtime-status`는 `x-work4-token`을 사용하므로 새로운 인증 토큰은 필요하지 않습니다.

## 2. Relay Function에 필요한 최소 변경

배포된 `index.tsx`의 `ROUTES` 객체에 **한 줄만** 추가합니다.

```diff
 const ROUTES: Record<string, { path: string; method: string }> = {
   "/job": { path: "/work4/job-upload", method: "POST" },
   "/images": { path: "/work4/work3-upload", method: "POST" },
   "/draft-list": { path: "/debug/draft-list", method: "GET" },
   "/auth-check": { path: "/debug/targets", method: "GET" },
   "/status": { path: "/health", method: "GET" },
   "/pipeline-status": { path: "/pipeline/status", method: "GET" },
+  "/runtime-status": { path: "/work4/runtime-status", method: "GET" },
 };
```

`/runtime-status`를 `/pipeline/status`로 연결하면 **안 됩니다**. 실행 중인 `work4RunPromise`와 현재 runtime job·대기 이미지는 `/work4/runtime-status`가 담당합니다.

## 3. 승인 후 적용 순서

1. 현재 controller/Relay 소스·배포 커밋·Function 전체 코드 백업, 롤백 대상 확정.
2. `main`의 runtime route 포함 커밋을 **고정된 커밋 SHA**로 controller에 배포할 수 있는지 검증하고, 승인된 경로로만 반영. 기존 운영 배포가 구버전인 상태에서 Relay부터 연결하면 404가 계속 발생합니다.
3. controller 내부 인증 GET `/work4/runtime-status`가 200을 반환하는지 확인. 비밀 토큰을 로그에 남기지 않음.
4. Relay 전체 Function 소스를 백업하고 위 한 줄을 추가한 **전체 코드**를 배포. `GET /runtime-status`가 인증된 200을 반환하고 무인증 요청은 403인지 확인.
5. 응답에서 `active_execution`, `work4_promise_active`, `runtime_job_file_present`, `runtime_job.content_id`, `pending_image_count`를 확인.
6. **읽기 전용 조회는 원자적 락이 아닙니다.** 실제 `/job` POST 전에는 같은 콘텐츠 ID의 중복 전송 방지와 다른 실행의 충돌 방지 게이트가 별도로 필요합니다.
7. 008 → 037 → 038 → 039 순서로 기존 Work1~3 원고/Work3 이미지·매니페스트·job만 사용하여 각 건을 임시저장→목록 재열기→서식·이미지 검증 후 다음 건으로 이동. 007 SKIPPED_BY_USER, 032 DONE_VERIFIED는 재전송 금지.

## 4. 완료 기준

- controller와 Relay에서 각각 인증된 runtime-status 200, 무인증 403.
- 런타임 job·실행 잠금·대기 이미지 상태를 조회할 수 있고 비밀값·원고 본문은 응답에 포함되지 않음.
- 실제 POST 전 중복/경합 방지 검증. 상태가 불확실하면 자동 업로드 금지.
- 네이버 임시저장과 목록 재열기 성공, `draft_reopen_verified=true`, `published=false`, Work3 원본 해시/순서 일치.

**이 문서는 구현 준비물입니다. 운영 변경·실제 네이버 업로드는 수행하지 않았습니다.**
