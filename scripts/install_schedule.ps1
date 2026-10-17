# Windows 작업 스케줄러에 "ER 데이터 갱신"(scripts/refresh_local.ps1)을 등록한다(이미 있으면 덮어씀).
# 매일 12:00, 놓치면 다음에 가능할 때(로그온·부팅 뒤) 실행, 숨김 창, 작업 디렉터리 = 저장소 루트. 현재 사용자로 등록한다.
# 실행: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_schedule.ps1   (해제: scripts\uninstall_schedule.ps1)
# 이 파일은 Windows PowerShell 5.1 이 한글을 읽도록 UTF-8(BOM)으로 저장한다.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'refresh_local.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Daily -At '12:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ER 데이터 갱신' -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description '이터널 리턴 계산기 데이터(dak.gg·패치노트·나무위키) 수집 → data/ 커밋·푸시 → data-latest 릴리스 업로드' | Out-Null
Write-Output "등록됨: ER 데이터 갱신 (매일 12:00, $script)"
