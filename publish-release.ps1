$git = "C:\Program Files\Git\cmd\git.exe"
$inputStr = "url=https://github.com`n`n"
$cred = $inputStr | & $git credential fill
$token = ($cred | Where-Object { $_.StartsWith("password=") }).Substring(9)
$headers = @{ Authorization = "token $token"; "User-Agent" = "PS" }
$repo = "fouliny/layerlibrary"
# 自动从 hostscript.jsx 读取版本号（支持 32 / 32.1 / 32.1.1 语义化版本），避免每次发布手改
$ver = (Select-String -Path "JSX\hostscript.jsx" -Pattern "PSL_SCRIPT_VERSION[^0-9]*(\d+(?:\.\d+)*)" | Select-Object -First 1).Matches[0].Groups[1].Value
$zip = "releases\MuMuHelper-v$ver.zip"
$tag = "v$ver"
Write-Output ("version: " + $ver + ", zip: " + $zip)

# 1. check if tag v18 release exists
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -TimeoutSec 20
    Write-Output "release $tag already exists: $($existing.html_url)"
    $rel = $existing
} catch {
    # 2. create release
    $body = @{
        tag_name = $tag
        name = "MuMu助手 v$ver"
        body = "## MuMu助手 v$ver`n`n### ✨ 本次新增`n- 宽面板分类栏拖拽排序:拖动分类行到目标行上半/下半区即可调整顺序,松开立即保存,重启不丢`n- 多选图层保存自动编组:选中的多个图层保存时自动编成一个组,插入画布时整组一次复制到位`n- 插入不再逐层闪烁:多层素材(旧素材/手工整理的PSD)插入前先在源文档编组,整组一次性复制+居中`n- 置顶/手动排序后保持滚动视野:重排结果立即生效,列表不再跳回顶部`n`n### ✨ 此前版本亮点`n- 语义化版本(主.次.修订):小改动只升小数点,检查更新/打包/发布全链路兼容`n- Mac 支持:自动更新 shell 分支、一键部署 .command 脚本`n- 检查素材/重建索引/检查更新全程进度条可视化`n- 修复远程同步后素材不显示、切换素材库全变未分类等问题`n`n### 📦 部署`n- Windows:下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可`n- Mac:下载 zip 解压,双击【一键部署MuMu助手.command】(无权限时终端执行 bash 一键部署MuMu助手.command),重启 Photoshop 即可"
        draft = $false
        prerelease = $false
    } | ConvertTo-Json
    $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 30
    Write-Output "release created: $($rel.html_url)"
}

# 3. upload asset
$uploadUrl = $rel.upload_url.Split("{")[0]
$assetHeaders = @{ Authorization = "token $token"; "User-Agent" = "PS"; "Content-Type" = "application/zip" }
$asset = Invoke-RestMethod -Method Post -Uri ($uploadUrl + "?name=MuMuHelper-v$ver.zip") -Headers $assetHeaders -InFile $zip -TimeoutSec 120
Write-Output ("asset uploaded: " + $asset.name + " (" + $asset.size + " bytes)")

# 4. verify
$check = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -TimeoutSec 20
Write-Output "assets: $($check.assets | ForEach-Object { $_.name })"
