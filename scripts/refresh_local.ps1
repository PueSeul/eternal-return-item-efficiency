# 호스트 PC 의 매일 데이터 갱신(작업 스케줄러 "ER 데이터 갱신", scripts/install_schedule.ps1 이 등록).
# 저장소 폴더에서 git pull --ff-only → node scripts/refresh_data.mjs(스킬 전체, 나무위키 요청 간격 1초)
# → data/ 가 바뀌었으면 커밋·git push origin main → data-latest 릴리스(없으면 생성)에 자산 5개 업로드(--clobber).
# git·gh 인증은 이 PC 의 기존 로그인을 쓴다. 결과는 handoff/refresh-local.log 에 한 줄(실패면 오류 전체).
# 이 파일은 Windows PowerShell 5.1 이 한글을 읽도록 UTF-8(BOM)으로 저장한다.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'handoff'
$log = Join-Path $logDir 'refresh-local.log'
$started = Get-Date
$release = Join-Path ([IO.Path]::GetTempPath()) ('er-data-release-' + [guid]::NewGuid().ToString('N'))

function Write-Log([string]$text) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) -Encoding UTF8
}

# 외부 명령 실행: 종료 코드가 0 이 아니면 명령과 출력 전체를 담아 throw. 출력은 문자열로 돌려준다.
function Invoke-Checked([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue' # 표준 오류 출력만으로 멈추지 않게(종료 코드로 판단)
  try {
    $out = & $exe @argv 2>&1 | Out-String
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($LASTEXITCODE -ne 0) { throw ('{0} {1} 실패(exit {2}):{3}{4}' -f $exe, ($argv -join ' '), $LASTEXITCODE, [Environment]::NewLine, $out.Trim()) }
  return $out
}

try {
  Set-Location $root
  $branch = (Invoke-Checked git @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
  if ($branch -ne 'main') { throw "현재 브랜치가 main 이 아닙니다($branch)." }
  if ((Invoke-Checked git @('status', '--porcelain', '--', 'data/')).Trim()) { throw 'data/ 에 커밋하지 않은 변경이 있어 중단합니다.' }
  Invoke-Checked git @('pull', '--ff-only', 'origin', 'main') | Out-Null
  # 푸시는 자동 갱신 커밋만: 로컬 main 에 푸시 안 된 다른 커밋이 있으면 중단한다
  # (지난 실행의 푸시가 실패해 남은 자동 갱신 커밋은 이번에 함께 푸시).
  $ahead = @((Invoke-Checked git @('log', '--format=%s', 'origin/main..HEAD')).Trim() -split "`r?`n" | Where-Object { $_ })
  $other = @($ahead | Where-Object { $_ -notmatch '^\[data\] \d{4}-\d{2}-\d{2} 자동 갱신$' })
  if ($other.Count) { throw ('로컬 main 에 푸시하지 않은 다른 커밋이 {0}개 있어 중단합니다: {1}' -f $other.Count, ($other -join ' | ')) }

  $summary = (Invoke-Checked node @('scripts/refresh_data.mjs', $release)).Trim()

  $diff = (Invoke-Checked git @('status', '--porcelain', '--', 'data/')).Trim()
  if ($diff) {
    Invoke-Checked git @('add', '--', 'data/') | Out-Null
    # 경로 지정 커밋: 다른 파일이 스테이징돼 있어도 data/ 만 커밋한다.
    Invoke-Checked git @('commit', '-m', ('[data] {0} 자동 갱신' -f (Get-Date -Format 'yyyy-MM-dd')), '--', 'data/') | Out-Null
    $data = 'data/ 커밋·푸시'
  } else {
    $data = 'data/ 변경 없음'
  }
  if ($diff -or $ahead.Count) {
    Invoke-Checked git @('push', 'origin', 'main') | Out-Null
    if (-not $diff) { $data = "data/ 변경 없음, 남은 자동 갱신 커밋 $($ahead.Count)개 푸시" }
  }

  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & gh release view data-latest *> $null
  $exists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $prev
  if (-not $exists) {
    # 인자에 큰따옴표를 넣지 않는다(PowerShell 5.1 은 네이티브 명령 인자의 큰따옴표를 이스케이프하지 않아 인자가 갈라진다).
    Invoke-Checked gh @('release', 'create', 'data-latest', '--prerelease', '--target', 'main', '--title', '데이터 (자동 갱신)',
      '--notes', '매일 12:00(KST) 자동 갱신되는 데이터 파일입니다. 프로그램의 아이템 수치 업데이트 버튼이 받습니다.') | Out-Null
  }
  $assets = @(Get-ChildItem -File -Path $release | ForEach-Object { $_.FullName })
  Invoke-Checked gh (@('release', 'upload', 'data-latest') + $assets + @('--clobber')) | Out-Null

  Write-Log ('성공 {0}초: {1}; 자산 {2}개 업로드; {3}' -f [int]((Get-Date) - $started).TotalSeconds, $data, $assets.Count, $summary)
} catch {
  Write-Log ('실패 {0}초: {1}' -f [int]((Get-Date) - $started).TotalSeconds, ($_ | Out-String).Trim())
  exit 1
} finally {
  if (Test-Path $release) { Remove-Item -Recurse -Force $release }
}
