$git = "C:\Program Files\Git\cmd\git.exe"
$inputStr = "url=https://github.com`n`n"
$cred = $inputStr | & $git credential fill
$token = ($cred | Where-Object { $_.StartsWith("password=") }).Substring(9)
$headers = @{ Authorization = "token $token"; "User-Agent" = "PS" }
$repo = "fouliny/layerlibrary"
$zip = "c:\Users\xu\Desktop\ps\com.pslib.layerlibrary\releases\MuMuHelper-v18.zip"

# 1. check if tag v18 release exists
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/v18" -Headers $headers -TimeoutSec 20
    Write-Output "release v18 already exists: $($existing.html_url)"
    $rel = $existing
} catch {
    # 2. create release
    $body = @{
        tag_name = "v18"
        name = "MuMu助手 v18"
        body = "## MuMu助手 v18`n`n- 修复远程同步后素材不显示(同步阻塞复制 + 同步收尾强制全量重建)`n- 修复中文输入法打不出字(IME 组合键保护 + user-select + 弹窗重建输入框)`n- 版本升级自动清索引全量重建`n`n### 部署`n下载 zip 解压,双击【一键部署MuMu助手.bat】,重启 Photoshop 即可。"
        draft = $false
        prerelease = $false
    } | ConvertTo-Json
    $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 30
    Write-Output "release created: $($rel.html_url)"
}

# 3. upload asset
$uploadUrl = $rel.upload_url.Split("{")[0]
$assetHeaders = @{ Authorization = "token $token"; "User-Agent" = "PS"; "Content-Type" = "application/zip" }
$asset = Invoke-RestMethod -Method Post -Uri ($uploadUrl + "?name=MuMuHelper-v18.zip") -Headers $assetHeaders -InFile $zip -TimeoutSec 120
Write-Output ("asset uploaded: " + $asset.name + " (" + $asset.size + " bytes)")

# 4. verify
$check = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/v18" -Headers $headers -TimeoutSec 20
Write-Output "assets: $($check.assets | ForEach-Object { $_.name })"
