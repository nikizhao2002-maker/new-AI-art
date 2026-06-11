# outputs-video 独立预览服务器（可选）
# ------------------------------------------------------------------
# 正常使用无需运行本脚本：请在项目根目录运行  python serve.py
# 主程序已收敛为单服务器，制灯视频通过同源 ./outputs-video/ 提供。
#
# 本脚本仅在你想单独预览 outputs-video 时使用，使用 PATH 中的 Python，
# 不再依赖任何写死的绝对路径（修复原脚本写死他人机器路径的问题）。
Set-Location $PSScriptRoot

$py = $null
foreach ($cmd in @('python', 'py', 'python3')) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { $py = $cmd; break }
}
if (-not $py) {
    Write-Host '未找到 Python，请先安装 Python 3 并加入 PATH。' -ForegroundColor Red
    exit 1
}

Write-Host 'outputs-video 独立预览: http://localhost:4174/'
& $py -m http.server 4174
