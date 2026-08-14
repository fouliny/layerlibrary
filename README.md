# MuMu助手 (MuMuHelper) — Photoshop 素材管理面板插件

一款运行在 Adobe Photoshop 里的素材管理面板插件。把磁盘文件夹当作素材库,分类即文件夹、素材即文件,支持本地秒开浏览、远程素材库同步、一键插入素材到当前文档。

## 功能

- **素材库管理**:可配置多个素材库,磁盘即真相——磁盘上有什么,面板就显示什么,自动扫描同步
- **秒开体验**:本地索引缓存(`.mu_index.json`),打开面板即渲染,后台增量扫描保持一致性
- **分类管理**:新建 / 重命名 / 删除分类,拖拽排序,自动在素材库中创建对应分类文件夹
- **素材操作**:
  - 保存素材:把当前选中图层(支持多选合并)一键保存为素材
  - 插入素材:插入到当前文档(智能对象 / 普通图层,不栅格化),支持多选图层整组还原
  - 重命名、删除(进回收站)
- **缩略图**:自动配对预览图(前缀匹配),PSD 缩略图按配对关系自动排除
- **加星置顶 + 手动排序**
- **远程素材库同步**:SMB 网络共享 / HTTP 服务器双通道,一键同步,完成后自动重建索引并立即显示,支持断点式增量复制
- **支持 Photoshop 2020 ~ 2026**(CSXS.9 ~ CSXS.13)

## 部署方法

### 方式一:自动部署(推荐)

1. 下载最新发布包 `MuMuHelper-vXX.zip`(见 Releases / releases 目录),解压到任意位置
2. 双击解压目录中的 **`一键部署MuMu助手.bat`**,脚本自动完成:
   - 将插件全部文件复制到 `%APPDATA%\Adobe\CEP\extensions\com.pslib.layerlibrary`
   - 写入注册表 `CSXS.9 ~ CSXS.13` 的 `PlayerDebugMode=1`,启用未签名扩展加载
3. 重启 Photoshop
4. 菜单:窗口 → 扩展 → **MuMu助手**
5. 打开面板设置,底部显示「MuMu助手 vXX · 已连接 PS(脚本 vXX)」即部署成功

### 方式二:手动部署

1. 下载发布包解压(或克隆本仓库),得到 `com.pslib.layerlibrary` 文件夹
2. 手动把整个文件夹复制到 `%APPDATA%\Adobe\CEP\extensions\`
   - 最终路径:`%APPDATA%\Adobe\CEP\extensions\com.pslib.layerlibrary\`
3. 启用未签名扩展(二选一):
   - 注册表编辑器导入以下内容,或手动执行命令(逐个 CSXS 节点,对应 PS 2020 ~ 2026):

     ```
     reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f
     reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f
     reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
     reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
     reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.13" /v PlayerDebugMode /t REG_SZ /d 1 /f
     ```
4. 重启 Photoshop,菜单:窗口 → 扩展 → **MuMu助手**

## 开发者

- **打包发布包**:双击 `build-release.bat`,自动读取 `hostscript.jsx` 中的版本号,生成 `releases\MuMuHelper-vXX.zip`(只含运行时文件与部署脚本)
- **修改代码后**:重新运行部署(方式一)即可生效;脚本版本号升级后,插件启动时会自动清空旧索引并全量重建,保证磁盘素材全部入库
- 架构:CEP 双层——前端 `main.js`(CEF 渲染)+ `JSX/hostscript.jsx`(ExtendScript,运行在 PS 主线程),通过 `evalScript` 桥接;素材库根目录的 `.mu_index.json` 为本地索引缓存(磁盘为唯一真相)

## 仓库结构

```
com.pslib.layerlibrary/
├── CSXS/manifest.xml        CEP 扩展清单(入口、CEF 参数、PS 版本范围)
├── JSX/hostscript.jsx       ExtendScript 主脚本(PS 主线程,含版本号)
├── images/                  面板图标(明暗两套)
├── index.html               面板界面骨架
├── main.js                  前端核心逻辑(扫描、分类、同步、设置)
├── styles.css               样式
├── 一键部署MuMu助手.bat     自动部署脚本
├── build-release.bat        发布包打包脚本
└── releases/                发布包输出目录
```
