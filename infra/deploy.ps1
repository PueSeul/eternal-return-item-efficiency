# (Re)deploy the daily data refresh Lambda (infra/lambda/handler.mjs) to ap-northeast-2. Idempotent:
# creates what is missing and updates the rest. Run from anywhere: powershell -File infra/deploy.ps1
#   - zip: infra/lambda/handler.mjs + scripts/*.mjs (no tests) + data/*.json, entry names with '/'
#   - IAM role er-refresh-lambda-role: write its own log group, read SSM /er-refresh/github-token only
#   - log group /aws/lambda/er-data-refresh, retention 14 days
#   - function er-data-refresh: nodejs22.x, 512 MB, 600 s, async retry 1
#   - EventBridge Scheduler er-data-refresh-daily: cron(0 12 * * ? *) Asia/Seoul, retry 1
# The token value is put by hand (SecureString): aws ssm put-parameter --name /er-refresh/github-token --type SecureString --value <PAT>
$ErrorActionPreference = 'Stop'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$region = 'ap-northeast-2'
$fn = 'er-data-refresh'
$role = 'er-refresh-lambda-role'
$schedRole = 'er-refresh-scheduler-role'
$schedule = 'er-data-refresh-daily'
$tokenParam = '/er-refresh/github-token'
$logGroup = "/aws/lambda/$fn"
$root = Split-Path -Parent $PSScriptRoot
$env:AWS_DEFAULT_REGION = $region
$env:AWS_PAGER = ''
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('er-deploy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

# Run aws; throw with the full output on a non-zero exit. Returns stdout as one string.
function Aws([string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $aws @argv 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw ('aws {0} failed (exit {1}):{2}{3}' -f ($argv -join ' '), $LASTEXITCODE, [Environment]::NewLine, $out.Trim()) }
  return $out.Trim()
}
# True when the aws command succeeds (existence checks).
function AwsOk([string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $aws @argv *> $null } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE -eq 0
}
# JSON argument through a file (Windows PowerShell 5.1 mangles double quotes in native arguments).
function JsonFile([string]$name, $value) {
  $file = Join-Path $tmp $name
  [IO.File]::WriteAllText($file, ($value | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))
  return 'file://' + $file
}

try {
  $account = Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
  $fnArn = "arn:aws:lambda:${region}:${account}:function:$fn"

  # --- package
  $zip = Join-Path $tmp 'lambda.zip'
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $files = @(Get-Item (Join-Path $root 'infra/lambda/handler.mjs'))
  $files += Get-ChildItem -File (Join-Path $root 'scripts') -Filter '*.mjs' | Where-Object { $_.Name -notlike '*.test.mjs' }
  $files += Get-ChildItem -File (Join-Path $root 'data') -Filter '*.json'
  $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
  try {
    foreach ($f in $files) {
      $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry)
    }
  } finally { $archive.Dispose() }
  Write-Host ('zip: {0} files, {1:N0} bytes' -f $files.Count, (Get-Item $zip).Length)

  # --- Lambda execution role (logs of its own group + the token parameter only)
  $lambdaTrust = JsonFile 'lambda-trust.json' @{ Version = '2012-10-17'; Statement = @(@{ Effect = 'Allow'; Principal = @{ Service = 'lambda.amazonaws.com' }; Action = 'sts:AssumeRole' }) }
  $newRole = -not (AwsOk @('iam', 'get-role', '--role-name', $role))
  if ($newRole) { Aws @('iam', 'create-role', '--role-name', $role, '--assume-role-policy-document', $lambdaTrust) | Out-Null }
  $lambdaPolicy = JsonFile 'lambda-policy.json' @{ Version = '2012-10-17'; Statement = @(
      @{ Effect = 'Allow'; Action = @('logs:CreateLogStream', 'logs:PutLogEvents'); Resource = "arn:aws:logs:${region}:${account}:log-group:${logGroup}:*" },
      @{ Effect = 'Allow'; Action = 'ssm:GetParameter'; Resource = "arn:aws:ssm:${region}:${account}:parameter$tokenParam" }) }
  Aws @('iam', 'put-role-policy', '--role-name', $role, '--policy-name', 'er-refresh-min', '--policy-document', $lambdaPolicy) | Out-Null

  # --- log group (14 days)
  if (-not (Aws @('logs', 'describe-log-groups', '--log-group-name-prefix', $logGroup, '--query', "logGroups[?logGroupName=='$logGroup'].logGroupName", '--output', 'text'))) {
    Aws @('logs', 'create-log-group', '--log-group-name', $logGroup) | Out-Null
  }
  Aws @('logs', 'put-retention-policy', '--log-group-name', $logGroup, '--retention-in-days', '14') | Out-Null

  # --- function
  $config = @('--runtime', 'nodejs22.x', '--handler', 'infra/lambda/handler.handler', '--memory-size', '512', '--timeout', '600')
  if (AwsOk @('lambda', 'get-function', '--function-name', $fn)) {
    Aws @('lambda', 'update-function-code', '--function-name', $fn, '--zip-file', "fileb://$zip") | Out-Null
    Aws @('lambda', 'wait', 'function-updated-v2', '--function-name', $fn) | Out-Null
    Aws (@('lambda', 'update-function-configuration', '--function-name', $fn, '--role', "arn:aws:iam::${account}:role/$role") + $config) | Out-Null
    Aws @('lambda', 'wait', 'function-updated-v2', '--function-name', $fn) | Out-Null
  } else {
    if ($newRole) { Start-Sleep -Seconds 15 } # IAM propagation before Lambda can assume the new role
    Aws (@('lambda', 'create-function', '--function-name', $fn, '--role', "arn:aws:iam::${account}:role/$role", '--zip-file', "fileb://$zip") + $config) | Out-Null
    Aws @('lambda', 'wait', 'function-active-v2', '--function-name', $fn) | Out-Null
  }
  # Scheduler invokes asynchronously: a failed run (function error) is retried once by Lambda.
  Aws @('lambda', 'put-function-event-invoke-config', '--function-name', $fn, '--maximum-retry-attempts', '1', '--maximum-event-age-in-seconds', '3600') | Out-Null

  # --- scheduler role + schedule (12:00 Asia/Seoul daily, delivery retry 1)
  $schedTrust = JsonFile 'scheduler-trust.json' @{ Version = '2012-10-17'; Statement = @(@{ Effect = 'Allow'; Principal = @{ Service = 'scheduler.amazonaws.com' }; Action = 'sts:AssumeRole'; Condition = @{ StringEquals = @{ 'aws:SourceAccount' = $account } } }) }
  $newSchedRole = -not (AwsOk @('iam', 'get-role', '--role-name', $schedRole))
  if ($newSchedRole) { Aws @('iam', 'create-role', '--role-name', $schedRole, '--assume-role-policy-document', $schedTrust) | Out-Null }
  $schedPolicy = JsonFile 'scheduler-policy.json' @{ Version = '2012-10-17'; Statement = @(@{ Effect = 'Allow'; Action = 'lambda:InvokeFunction'; Resource = @($fnArn, "${fnArn}:*") }) }
  Aws @('iam', 'put-role-policy', '--role-name', $schedRole, '--policy-name', 'invoke-er-data-refresh', '--policy-document', $schedPolicy) | Out-Null
  if ($newSchedRole) { Start-Sleep -Seconds 15 }
  $target = JsonFile 'target.json' @{ Arn = $fnArn; RoleArn = "arn:aws:iam::${account}:role/$schedRole"; Input = '{}'; RetryPolicy = @{ MaximumRetryAttempts = 1; MaximumEventAgeInSeconds = 3600 } }
  $sched = @('--name', $schedule, '--schedule-expression', 'cron(0 12 * * ? *)', '--schedule-expression-timezone', 'Asia/Seoul',
    '--flexible-time-window', 'Mode=OFF', '--state', 'ENABLED', '--target', $target)
  $verb = if (AwsOk @('scheduler', 'get-schedule', '--name', $schedule)) { 'update-schedule' } else { 'create-schedule' }
  Aws (@('scheduler', $verb) + $sched) | Out-Null

  $hasToken = AwsOk @('ssm', 'get-parameter', '--name', $tokenParam)
  Write-Host "deployed $fn (schedule $schedule, cron(0 12 * * ? *) Asia/Seoul); token parameter ${tokenParam}: $(if ($hasToken) { 'present' } else { 'MISSING' })"
} finally {
  Remove-Item -Recurse -Force $tmp
}
