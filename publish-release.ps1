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
                body = "## MuMu助手 v32.2.1`n`n### ✨ 本次新增`n- 排序随库走:分类顺序/素材手动排序固化进素材库根目录 .mu_index.json,U盘/硬盘拷贝素材库到任何电脑打开排序自动恢复`n- 远程同步大幅提速:检查素材改为增量更新,只复制新增/更新的素材,面板不再全量重建`n- Windows↔macOS 跨平台拷贝:自动过滤旧电脑路径的残留条目,排序按相对路径恢复,不再出现点不开的幽灵素材`n- 远程同步后分类顺序/素材排序与远程库保持一致(单向以远程为准)`n`n### ✨ 此前版本亮点`n- 宽面板分类栏拖拽排序、多选保存自动编组、插入整组一次到位`n- 语义化版本(主.次.修订):小改动只升小数点,检查更新/打包/发布全链路兼容`n- Mac 支持:自动更新 shell 分支、一键部署 .command 脚本`n- 检查素材/重建索引/检查更新全程进度条可视化`n`n### 📦 部署`n- Windows:下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可`n- Mac:下载 zip 解压,双击【一键部署MuMu助手.command】(无权限时终端执行 bash 一键部署MuMu助手.command),重启 Photoshop 即可"
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
