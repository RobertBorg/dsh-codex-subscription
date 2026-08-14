# dsh-llm-codex 部署接入脚本(管理员不需要;要求当前用户对 npm 全局目录可写)
#
# 作用:
#   1. 在 DSH 部署的 node_modules(@deepseek-ai/dsh/node_modules)里建立指向本仓库的
#      junction,使 cordis loader 能以 "dsh-llm-codex" 包名解析到本插件;
#   2. 校验解析是否成功;
#   3. 若 profile 的 cordis.patch.yml 尚未包含 llm-codex 行,打印需要追加的内容。
#
# 说明:junction 会被 `npm i -g @deepseek-ai/dsh` 升级清除;升级后重新运行本脚本即可。
# 该脚本幂等,可重复执行。

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshPkg = Join-Path (npm root -g) '@deepseek-ai\dsh'
$target = Join-Path $dshPkg 'node_modules\dsh-llm-codex'

if (-not (Test-Path (Join-Path $dshPkg 'package.json'))) {
    throw "未找到 DSH 部署包: $dshPkg"
}

# 1. 建立 junction(先清理指向别处的旧链接)
if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType -eq 'Junction') {
        $real = $item.Target
        if ($real -ne $repo) { Remove-Item $target -Force }
    } else {
        throw "目标已存在且不是 junction,请人工检查: $target"
    }
}
if (-not (Test-Path $target)) {
    New-Item -ItemType Junction -Path $target -Target $repo | Out-Null
    Write-Host "已创建 junction: $target -> $repo"
} else {
    Write-Host "junction 已就绪: $target"
}

# 2. 校验 loader 解析
Push-Location $dshPkg
try {
    $check = node --input-type=module -e "import('dsh-llm-codex').then(m => { console.log('resolve OK: name=' + m.name + ' provider=' + m.PROVIDER) }).catch(e => { console.error('resolve FAILED:', e.message); process.exit(1) })"
    if ($LASTEXITCODE -ne 0) { throw $check }
    Write-Host $check
} finally {
    Pop-Location
}

# 3. 检查 profile patch 是否已含 llm-codex 行
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (Test-Path $patch) {
    $content = Get-Content $patch -Raw
    if ($content -notmatch 'llm-codex') {
        Write-Host ''
        Write-Host '请在以下文件中追加插件行(profile 的 patch 层):'
        Write-Host "  $patch"
        Write-Host ''
        Write-Host '- insert:'
        Write-Host '    - id: llm-codex'
        Write-Host "      name: 'dsh-llm-codex'"
    } else {
        Write-Host 'profile patch 已包含 llm-codex 行。'
    }
}

Write-Host ''
Write-Host '完成。重启 dsh 后,Web 模型选择器将出现 "Codex (ChatGPT 订阅)"。'
