# 미리 작성한 원고 예약 발행

현재 사용 방식은 AI 생성 API 없이 원고·이미지를 미리 완성해 서버에 보관하는 방식입니다. `AUTO_GENERATE=false`이며 OpenAI 키가 없어도 발행됩니다. 모델 기반 생성 코드는 선택 기능으로 남겨 두었으며 운영 검증되지 않았습니다. 기본 운영에서는 호출하지 않습니다.

- 발행 대상: `https://blog.naver.com/tlsehdduq0152`
- 사용자 확인에 따라 001~037은 기존 업로드 완료로 취급합니다. 새 대기열은 038부터 시작합니다.
- 한국시간 매일 08:00 / 12:00 / 16:00 / 18:00에 1개씩 실행합니다. Railway cron은 UTC `0 3,7,9,23 * * *`입니다. 실행 시작과 브라우저 입력에 따라 게시 완료 시각은 몇 분 달라질 수 있습니다.
- 대기열이 비면 새 글을 만들거나 이전 글을 재발행하지 않고 준비된 원고를 기다립니다. 이번 등록분은 038~041 네 개이며 2026-11-01 하루 분량입니다. 이후 분량은 별도로 미리 제작해 추가해야 합니다.
- 사용자 PC나 채팅을 켜둘 필요가 없습니다. Railway 발행 서비스와 로그인된 Chromium 서비스가 실행 중이어야 합니다. 로그인이 만료되면 재로그인이 필요합니다.

## 안전한 진행 상태

`READY` → `RUNNING` → `PUBLISHED`. 최종 발행 전에 날짜·시간 슬롯을 디스크에 기록합니다. 응답 유실 등으로 게시 여부가 불명확하면 `BLOCKED`로 중단하며 다음 번호도 먼저 발행하지 않습니다. `/jobs/{id}`의 결과와 실제 글 URL을 대조한 후 조정해야 합니다. 프로세스를 재시작해도 이 상태는 `/data` 볼륨에 남습니다.

## 다음 묶음 추가

1. `AUTHORING.md`에 맞춰 실제 원고·대표 1+본문 5 이미지·원본 명함을 완성하고 법령 검토는 `internal-review.json`에 따로 보관합니다.
2. `job.json`에는 `content_id` 숫자, `editorial_style=consultation`, 순서와 일치하는 ID(예: `042-consultation-v91`)를 넣습니다. 001~037은 등록할 수 없습니다. 같은 번호를 중복 등록할 수 없습니다.
3. 비밀값을 저장소에 넣지 말고 기존 로컬 설정 파일을 사용합니다.

```text
node client.js upload <설정파일> <원고폴더/job.json>
node client.js queue <설정파일> <원고폴더/job.json>
node client.js queue-status <설정파일> <원고폴더/job.json>
```

`queue`는 예약 대기열 등록이며 즉시 발행하지 않습니다. 기존 `publish` 명령은 즉시 발행이므로 예약 등록에 사용하지 않습니다.

## 운영 API

모든 `/scheduler` 경로는 기존 Bearer API_TOKEN이 필요합니다. GET `/scheduler`는 설정과 대기열, GET `/scheduler/items/038`은 보관된 원고와 내부 검토를 반환합니다. POST `/scheduler/config`에는 enabled와 starts_at을 전달합니다. POST `/scheduler/queue`에는 content_id·job·audit를 전달합니다. POST `/scheduler/run`은 서버의 현재 시간으로만 슬롯을 판단합니다. 외부에서 임의의 시각을 넣어 발행할 수 없습니다.

실제 게시 후 제목·본문·표·강조·이미지 순서·카테고리·최종 명함을 대조하고 URL이 확인돼야 PUBLISHED로 기록합니다. 원고 038~041은 아직 예약 대기이며 실제 발행 완료로 표시하지 않습니다.
