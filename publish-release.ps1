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
                        body = "## MuMu助手 v32.2.6`n`n### ✨ 本次新增`n- 远程同步缩略图规则:远程缩略图比本地小才覆盖(远程小图覆盖本地大图,本地已压缩的小图不被远程旧大图覆盖回去)`n`n### ✨ 此前版本亮点`n- 缩略图全面瘦身 120px:存量超大缩略图一次性全部压缩,新素材入库缩略图即 120px,快速滚动预览流畅`n- 修复「组+普通图层」混合选中保存的素材插入报「非法参数」:嵌套组跨文档复制改递归逐层重建`n- 远程同步大幅提速:检查素材先对比远程/本地根目录索引,只复制指纹(mtime+大小)不同的文件,素材无变化时秒完成`n- 重建索引大幅提速:改为增量指纹扫描,只处理新增/变化的素材,不再全量重读所有文件`n- 排序随库走:分类顺序/素材手动排序固化进库内索引,U盘拷贝/换机/远程同步后排序一致`n- Windows↔macOS 跨平台拷贝:自动过滤旧路径残留条目并恢复排序`n- 语义化版本(主.次.修订):小改动只升小数点`n`n### 📦 部署`n- Windows:下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可`n- Mac:下载 zip 解压,双击【一键部署MuMu助手.command】(无权限时终端执行 bash 一键部署MuMu助手.command),重启 Photoshop 即可"
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
