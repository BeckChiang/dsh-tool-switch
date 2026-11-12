# 第一次发布（bootstrap）：npm 包必须先存在，之后才能在 npmjs 网站配 Trusted Publishing。
#
# 关键点：npm 只在 stdout 是**真 TTY** 时才肯走「打印链接 + 等你授权」的 web 2FA 流程。
# 之前的尝试都被 `| Tee-Object` 变成了管道 → npm 认为非交互 → 立刻 EOTP 退出。
# 所以这里不做任何管道/重定向，只用 Start-Transcript 在旁边留一份日志。
$log = Join-Path $env:TEMP 'publish-bootstrap.log'
Start-Transcript -Path $log -Force | Out-Null

Set-Location 'C:\Users\matsu\Documents\Codex\dsh-tool-switch'
$env:npm_config_auth_type = 'web'

Write-Host ''
Write-Host '=== 发布 dsh-tool-switch@0.2.0（首次，bootstrap）===' -ForegroundColor Cyan
Write-Host 'npm 会打印 https://www.npmjs.com/auth/cli/... 链接（或直接打开浏览器）。'
Write-Host '请在浏览器里用 Windows Hello / 通行密钥完成 2FA —— 这个窗口会一直等到发布结束。'
Write-Host ''

npm publish

$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) {
  Write-Host '=== 发布成功：https://www.npmjs.com/package/dsh-tool-switch ===' -ForegroundColor Green
  Write-Host '下一步：去 npmjs 包设置 → Trusted publishing 绑定 GitHub Actions，以后就不需要 2FA 和 token 了。'
} else {
  Write-Host "=== 发布失败（退出码 $code）：把窗口里的报错截图给我 ===" -ForegroundColor Yellow
}

Stop-Transcript | Out-Null
Write-Host '（窗口可以关掉了，日志在 ' $log '）'
