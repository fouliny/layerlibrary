$git = "C:\Program Files\Git\cmd\git.exe"
$inputStr = "url=https://github.com`n`n"
$cred = $inputStr | & $git credential fill
$token = ($cred | Where-Object { $_.StartsWith("password=") }).Substring(9)
$headers = @{ Authorization = "token $token"; "User-Agent" = "PS" }
$repo = "fouliny/layerlibrary"
# 自动从 hostscript.jsx 读取版本号，避免每次发布手改
$ver = (Select-String -Path "JSX\hostscript.jsx" -Pattern "PSL_SCRIPT_VERSION\s*=\s*(\d+)" | Select-Object -First 1).Matches[0].Groups[1].Value
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
        body = "## MuMu助手 v$ver`n`n### ✨ 新增`n- 「检查素材」同步过程可视化:进度条实时显示当前阶段(连接/对比/复制到第几个分类/下载第几个素材及百分比/重建索引),不再卡着不动`n- 「重建索引」同样带进度:实时显示正在重建第几个分类(共 N 个)`n- 设置面板新增「重建索引」按钮:以磁盘文件夹为准强制重建全部素材索引,磁盘有但面板不显示时一键修复`n- 设置面板新增「检查更新」按钮:自动查询 GitHub Releases,发现新版本静默下载并覆盖更新,完成后提示重启 PS`n- 更新过程可视化:进度条实时显示下载百分比(流式下载)/解压/覆盖安装各阶段,并展示下载位置(完成后自动清理)`n- 网络不可达/访问超时给出明确中文提示(提示开启代理/VPN)`n`n### 🐛 修复`n- 修复远程同步后「磁盘有素材、面板没有」:重建改为直接枚举磁盘文件夹(不再依赖可能静默失败的面板分类),新分类自动补全,同步收尾同步分类失败也不再阻断强制重建`n- 修复切换素材库后素材全部变成「未分类」(索引分类 id 与重建后新分类失配,改为按文件夹名反查归类)`n- 修复同步完成后停在空分类看不到新素材(自动跳转到有素材的分类)`n- 全量重建提升至 120 秒超时,大库/慢机不再静默丢分类素材,失败有提示`n- 兜底救回与全量重建并发互踩`n- 修复 PS2024「检查素材」误报宿主脚本执行失败(远程同步超时提升至 120 秒,错误文案区分超时/脚本加载失败/网络不可达)`n`n### 📦 部署`n下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可。"
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
