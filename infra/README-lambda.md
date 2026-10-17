# 데이터 자동 갱신(AWS Lambda, 서울)
- 함수 `er-data-refresh`(ap-northeast-2, Node 22, 512MB, 10분)가 EventBridge Scheduler `er-data-refresh-daily`(`cron(0 12 * * ? *)`, Asia/Seoul)로 매일 12:00에 `infra/lambda/handler.mjs`를 실행한다: 스킬 전체 수집(나무위키 1초 간격) → 바뀌었으면 GitHub API로 `data/` 4파일을 main에 커밋 → `data-latest` 릴리스 자산 5개 교체. 실패는 재시도 1회, 로그는 CloudWatch `/aws/lambda/er-data-refresh`(14일).
- GitHub 토큰은 SSM SecureString `/er-refresh/github-token`(이 저장소 contents:write PAT)에서 읽는다. 없으면 "토큰 없음"으로 실패한다: `aws ssm put-parameter --name /er-refresh/github-token --type SecureString --value <PAT>`(바꿀 때는 `--overwrite`).
- 재배포: `powershell -File infra/deploy.ps1`(역할·로그 그룹·함수·스케줄을 없으면 만들고 있으면 갱신).
- 시험 실행: `aws lambda invoke --function-name er-data-refresh --cli-read-timeout 700 out.json`, 수집·비교만 하려면 `{"dryRun":true}`를 담은 파일을 `--payload fileb://dry.json`으로 넘긴다(토큰 불필요, GitHub에 쓰지 않음). PC 작업 스케줄러("ER 데이터 갱신")와 같은 12:00에 돌면 커밋·자산 교체가 겹칠 수 있으니 토큰을 넣고 첫 성공을 확인한 뒤 PC 작업을 지운다(`scripts/uninstall_schedule.ps1`).
