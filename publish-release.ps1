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
        body = "## MuMu助手 v$ver`n`n- 修复远程同步检查超时误报(同步超时提升至 120 秒,适配慢速 SMB)`n- 错误提示区分超时与脚本加载失败`n`n### 部署`n下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可。"
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
