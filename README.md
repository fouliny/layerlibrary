<div align="center">

# 🎨 MuMu助手 · MuMuHelper

**免费开源的 Photoshop 素材库管理扩展**

把散落的素材收进一个「秒开」的素材库 · 一键插入 PS 画布 · 多电脑远程共享 · 自带自动更新

![版本](https://img.shields.io/badge/版本-v32.1.1-2ea44f)
![平台](https://img.shields.io/badge/平台-Windows%20%7C%20macOS-0078d4)
![开源](https://img.shields.io/badge/开源-是-green)
![更新](https://img.shields.io/badge/更新-2026.08-orange)

</div>

---

## ✨ 功能特性

<div align="center">

<table width="75%" align="center">
<thead>
<tr><th align="left">功能</th><th align="left">说明</th></tr>
</thead>
<tbody>
<tr><td><strong>📁 素材库管理</strong></td><td>分类文件夹、缩略图网格、本地索引 <strong>秒开</strong>,万级素材不卡顿</td></tr>
<tr><td><strong>🖱️ 一键插入</strong></td><td>点击或拖拽素材即插入 PS 画布,自动缩放适配目标图层</td></tr>
<tr><td><strong>💾 保存素材</strong></td><td>选中多个图层一键合并存为素材,自动生成缩略图</td></tr>
<tr><td><strong>⭐ 加星置顶</strong></td><td>常用素材加星排序,支持手动拖拽调整顺序</td></tr>
<tr><td><strong>🔍 快速搜索</strong></td><td>按名称 / 分类即时过滤,秒级定位素材</td></tr>
<tr><td><strong>🔄 远程素材库</strong></td><td>SMB / HTTP 同步,多台电脑共享同一个素材库</td></tr>
<tr><td><strong>💻 跨平台</strong></td><td>Windows 与 macOS 同一套代码,部署脚本各自提供</td></tr>
</tbody>
</table>

</div>

---

## ⚖️ 与同类产品对比

> 基于各产品官网 / 公开信息核实(2026-08)

<div align="center">

<table width="75%" align="center">
<thead>
<tr><th align="left" nowrap>对比项</th><th align="left"><strong>MuMu助手</strong>(本仓库)</th><th align="left">图牛助理(ps6b.com)</th><th align="left">稿定PS设计助理(pszhuli.com)</th></tr>
</thead>
<tbody>
<tr><td nowrap><strong>💰 价格</strong></td><td><strong>免费 · 开源 · 无广告</strong></td><td>免费(约九成功能)</td><td>会员订阅(15 天免费体验)</td></tr>
<tr><td nowrap><strong>📦 素材库</strong></td><td><strong>本地素材库</strong>:分类 / 缩略图 / 秒开索引 / 加星 / 多选合并</td><td>素材库:免扣素材 / 电商模板(云端)</td><td>模板素材:本地复用 + 在线模板库</td></tr>
<tr><td nowrap><strong>🔐 素材归属</strong></td><td><strong>100% 本地,数据完全自控</strong></td><td>云端,依赖厂商服务器</td><td>云端,依赖稿定服务器</td></tr>
<tr><td nowrap><strong>🖥️ 多电脑同步</strong></td><td><strong>SMB / HTTP 自建服务器</strong>,不经第三方</td><td>云端上传分享</td><td>云端同步(团队付费)</td></tr>
<tr><td nowrap><strong>💿 平台</strong></td><td>Windows + macOS</td><td>Windows + macOS</td><td>Windows + macOS(PS 2017+)</td></tr>
<tr><td nowrap><strong>🐙 开源</strong></td><td><strong>是(GitHub 公开源码)</strong></td><td>否</td><td>否</td></tr>
</tbody>
</table>

</div>

---

## 🚀 快速开始

### 🪟 Windows

1. 下载最新版 `MuMuHelper-v*.zip` → [Releases](https://github.com/fouliny/layerlibrary/releases)
2. 解压后双击 **【一键部署MuMu助手.bat】**
3. 重启 Photoshop → `窗口 → 扩展(旧版) → MuMu助手`

### 🍎 macOS

1. 下载最新版 `MuMuHelper-v*.zip` → [Releases](https://github.com/fouliny/layerlibrary/releases)
2. 解压后双击 **【一键部署MuMu助手.command】**

   > 若提示没有执行权限,在终端执行:
   > ```bash
   > bash 一键部署MuMu助手.command
   > ```
3. 重启 Photoshop → `窗口 → 扩展(旧版) → MuMu助手`

> 💡 未签名扩展需启用调试模式:Windows 部署脚本自动写注册表;macOS 自动执行 `defaults write` 启用,无需手动操作。

---

## 🔄 远程素材库(多电脑共享)

<div align="center">

<table width="75%" align="center">
<thead>
<tr><th align="left">方式</th><th align="left">填写示例</th><th align="left">说明</th></tr>
</thead>
<tbody>
<tr><td><strong>📁 SMB 共享</strong></td><td><code>smb://服务器/共享/素材库</code> 或 <code>\服务器\共享\素材库</code></td><td>任一台电脑更新素材,其他电脑点「检查素材」即同步</td></tr>
<tr><td><strong>🌐 HTTP 静态目录</strong></td><td><code>http://服务器/素材库</code></td><td>目录需含 <code>.mu_index.json</code> 索引</td></tr>
</tbody>
</table>

</div>

- 同步由「检查素材」按钮**手动触发**,不会自动改动本地素材
- 同步 / 重建全程进度条提示,完成自动跳转到新素材

---

## 📜 更新历史

- 🆕 **v32.1.1** — 版本号改语义化(主.次.修订),比较 / 更新 / 打包 / 发布全链路兼容带点版本
- 🍎 **v32** — Mac 支持:自动更新 shell 脚本分支、临时目录跨平台、一键部署 `.command`
- 🔧 **v28 - v31** — 「重建索引」按钮、同步 / 重建进度条、设置面板排版优化、版本区居中
- ⚡ **v22 - v26** — 自动更新(检查更新 / 进度条 / 下载位置透明)、索引秒开架构

---

## 📄 声明

本项目为个人开源项目,与 Adobe 无关联。Photoshop 为 Adobe 注册商标。
