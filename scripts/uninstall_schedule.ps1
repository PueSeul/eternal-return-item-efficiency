# 작업 스케줄러의 "ER 데이터 갱신"(scripts/install_schedule.ps1)을 지운다. 없으면 아무것도 하지 않는다.
# 이 파일은 Windows PowerShell 5.1 이 한글을 읽도록 UTF-8(BOM)으로 저장한다.
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName 'ER 데이터 갱신' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'ER 데이터 갱신' -Confirm:$false
  Write-Output '삭제됨: ER 데이터 갱신'
} else {
  Write-Output '등록된 작업 없음: ER 데이터 갱신'
}
