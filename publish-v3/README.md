# 네이버 실제 발행 컨트롤러 v3

기존 draft_only 컨트롤러와 분리된 실제 발행 서비스입니다. 대상 블로그는 `tlsehdduq0152`로 제한합니다. 시작·재배포 때 자동 발행하지 않으며 인증한 요청만 처리합니다.

## 실제 검증 결과 — 2026-10-31

- 첫 글: [개원 인테리어 비용, 한 번에 비용 처리하기 전 확인할 3가지](https://blog.naver.com/tlsehdduq0152/224460314310)
- 실제 발행 후 다시 열어 제목, 원고 순서, 표 셀, 굵게, 형광펜, 일반 문장의 서식 초기화, 대표 이미지 개수를 검증했습니다.
- 동일 ID와 원고를 다시 전송하면 기존 발행 URL을 반환합니다. 재발행하지 않는 것을 실제 API로 확인했습니다.
- 로컬 테스트 13개 통과: 콘텐츠 검증, HTML 이스케이프, 명시적 강조/일반 서식 렌더링, CDP 연결, 디스크 저장, 동시 실행 방지, 발행 응답 유실, 업로드 API, 안전한 재시도.
- 브라우저 연결 시 Chromium의 내부 Host 요구에 맞춰 `/json/version`을 조회하고 내부 WebSocket 주소로 연결합니다. CDP를 외부에 공개하지 않습니다.

## 배포

Railway 프로젝트: `6a7d84b4-1738-421b-91e6-5036a1f3a6b0`

서비스: `naver-publisher-v3` (`d22e6671-bcf5-4dfc-a5cf-e2abf1c4548b`)

주소: `https://naver-publisher-v3-production.up.railway.app`

- 소스: `feat/publisher-v3-20261031`의 검증 커밋, Root Directory `/publish-v3`.
- Node 22+, 빌드 `npm install --omit=dev`, 실행 `npm start`.
- 단일 replica, sfo, 영구 볼륨 `/data` 500MB.
- 필수 환경변수: `DATA_DIR=/data`, `API_TOKEN` (32자 이상), `CDP_ENDPOINT`, `PORT=8080`.
- 브라우저: 기존 `naver-chromium` 서비스의 로그인된 프로필을 사용합니다. 비밀번호·쿠키를 이 서비스나 GitHub에 저장하지 않습니다. 로그인/추가 인증이 필요하면 발행을 중단합니다.
- 기존 컨트롤러, 릴레이와 다른 자동화 서비스는 변경하지 않았습니다.

## API

`GET /health` 외에는 `Authorization: Bearer <API_TOKEN>`이 필요합니다. 토큰을 URL에 넣지 않습니다.

| 경로 | 동작 |
|---|---|
| `GET /health` | 버전·busy·배포 커밋 |
| `PUT /assets/<단순파일명>.png` | PNG 바이트를 영구 저장. 같은 이름의 다른 내용은 거절 |
| `GET /assets/<단순파일명>.png` | 이미지/검증 화면 다운로드 |
| `POST /jobs` | 구조화 원고를 받아 실제 발행 실행 |
| `GET /jobs/<id>` | 원고, 진행 단계, 상태, 오류 및 발행 URL |
| `POST /jobs/<id>/retry` | 최종 발행 클릭 전 FAILED 작업만 재시도 |
| `POST /jobs/<id>/verify` | PUBLISHED 글만 다시 열어 검증·화면 저장. 발행하지 않음 |

`202 ACCEPTED`는 발행 완료가 아닙니다. 응답 전에 QUEUED와 원고를 디스크에 저장하며, 완료 여부는 상태 조회의 PUBLISHED 및 URL로 판단합니다.

## CLI

```text
node client.js upload settings.json job.json
node client.js publish settings.json job.json
node client.js status settings.json job.json
node client.js verify settings.json job.json
node client.js retry settings.json job.json
node preview.js job.json
```

settings.json에는 API_TOKEN을 저장합니다. 이 파일은 저장소 밖에 두세요. URL은 client.js에 위 서비스로 고정되어 있습니다. status는 원고 폴더에 runtime-status.json, verify는 verification.json과 published.png를 저장합니다. preview는 로컬 preview.html을 만듭니다.

## 원고 형식

```json
{
  "id":"unique-content-id",
  "blog":"tlsehdduq0152",
  "mode":"publish",
  "title":"검토한 실제 제목",
  "blocks":[
    {"type":"heading","runs":[{"text":"핵심 확인사항","bold":true}]},
    {"type":"paragraph","runs":[{"text":"강조할 문장","bold":true,"highlight":true}]},
    {"type":"paragraph","runs":[{"text":"다음 일반 문장은 강조를 초기화합니다."}]},
    {"type":"table","rows":[["구분","확인사항"],["증빙","계약서와 결제내역"]]},
    {"type":"image","file":"content-01.png","alt":"설명 이미지"}
  ]
}
```

이미지는 원고 순서에 따라 네이버 사진 업로더로 입력합니다. 텍스트는 실제 HTML 클립보드 붙여넣기로 편집기 문서 모델에 반영합니다. 임의 DOM 삽입으로 본문을 조작하지 않습니다. 표는 2~3열을 허용합니다. 각 run의 글자 크기·굵기·배경색을 명시해 다음 문장에 강조가 번지는 것을 방지합니다. 출처의 href는 이름과 전체 HTTPS 주소가 보이는 형태로 입력합니다. 네이버가 링크 카드를 추가할 수 있습니다.

## 상태·복구

QUEUED → EDITING → PUBLISHING → VERIFYING → PUBLISHED.

발행 설정 창 준비와 검증까지는 EDITING입니다. 최종 확인 버튼 클릭 직전에 PUBLISHING을 fsync해 기록합니다. 이 시점 이후 오류는 NEEDS_RECONCILIATION으로 남기고 자동 재발행하지 않습니다. 그 이전 실패만 `/retry`를 허용합니다. 초기 버전에서 최종 버튼 선택자가 버튼을 찾기 전에 중단한 것으로 확정된 특정 오류는 코드에 명시한 보정 규칙만 적용합니다.

실행 중 강제 종료되면 `.worker-lock`이 남아 다음 실행을 차단합니다. 프로세스가 종료됐는지와 발행 여부를 먼저 확인한 뒤 운영자가 잠금을 정리해야 합니다. NEEDS_RECONCILIATION에 새 ID를 부여해 재발행하지 마세요. 다중 replica·공유 네트워크 파일시스템은 지원하지 않습니다.

## 남은 운영 범위

- 이번 검증은 첫 원고 한 편입니다. 상시 AI 원고/이미지 생성과 정기 발행 일정은 아직 연결하지 않았습니다. API에 준비된 원고를 전달하면 발행하는 구조입니다.
- 카테고리는 편집기 기본값(첫 검증에서는 ‘세무사’), 주제는 기존 ‘비즈니스·경제’, 공개범위는 전체공개를 확인합니다. 카테고리 자동 분류는 미구현입니다.
- 이미지 alt 값 입력, 이미지 원본 해시와 게시 이미지의 동일성, 대표이미지 메타데이터 지정은 별도 미구현입니다. 이미지 개수를 검증합니다.
- 임시저장 모드는 지원하지 않습니다. 태그 입력 분기는 있으나 이번 글에서는 태그 필드를 사용하지 않았습니다.
- 네이버 UI가 바뀌면 검증 오류로 중단될 수 있습니다. 브라우저 쿠키, 비밀번호, 세무 상담 개인정보를 원고나 로그에 넣지 마세요.
