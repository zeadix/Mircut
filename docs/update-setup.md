# VEditor 软件更新配置指南

机制与 open_zoo/OpenNex 相同:**公开托管的 `latest.json` 清单 + 客户端比较版本**。
应用启动后点「项目 → 检查更新」拉取清单,显示是否有新版本与更新说明。

## 1. 清单格式(latest.json)

```json
{
  "version": "1.1.0",
  "download_url": "https://example.com/downloads/v1.1.0",
  "changes": [
    "新增:字幕样式配置",
    "修复:导入失败问题"
  ],
  "changes_en": [
    "Added subtitle style config",
    "Fixed import failure"
  ]
}
```

- `version`:与客户端比较的语义化版本(可带 v 前缀);
- `download_url`:新版安装包/发布页地址(有新版本时弹窗显示「前往下载」);
- `changes` / `changes_en`:中英双语更新说明列表。

## 2. 托管方式一:GitHub(推荐,零成本)

**静态文件(最简单)**:在任意公开仓库(或现有仓库的 `docs/` 分支)放一份
`latest.json`,URL 填 raw 地址:

```
https://raw.githubusercontent.com/<用户>/<仓库>/main/latest.json
```

**GitHub Pages**:仓库 Settings → Pages 启用后,`latest.json` 放在分支根目录:

```
https://<用户>.github.io/<仓库>/latest.json
```

**安装包发布**:打 tag 推送,在 GitHub Releases 上传各平台安装包,
`download_url` 填 Releases 页面地址即可(客户端只展示链接,不做自动安装)。

## 3. 托管方式二:Cloudflare

**Cloudflare Pages**(推荐):`npx wrangler pages deploy <目录> --project-name=veditor-updates`,
目录里放 `latest.json` 与安装包,得到 `https://<项目>.pages.dev/latest.json`。
Pages 自带全球 CDN,免费额度足够。

**Cloudflare R2 + 自定义域**(open_zoo 同款):`wrangler r2 object put <桶>/latest.json --file=latest.json`,
绑定自定义域(如 `updates.<你的域名>`)后填入 `UPDATE_MANIFEST_URL`。
适合配套 CI 自动发布(参考 open_zoo `.github/workflows/release.yml`)。

> 注意:更新检查由 Tauri 后端(ureq)发起,不受浏览器 CORS 限制;
> 两种托管都无需额外响应头。

## 4. 接线(一次性)

把实际清单地址填入 `app/src-tauri/src/main.rs`:

```rust
const UPDATE_MANIFEST_URL: &str = "https://你的托管地址/latest.json";
```

重新构建应用即生效。

## 5. 发新版本流程

1. 更新版本号(`Cargo.toml` workspace `version` 与 `tauri.conf.json` `version`);
2. 构建各平台安装包并发布(手动或 CI);
3. 更新 `latest.json`(version / download_url / changes)上传到托管地址。

客户端下次「检查更新」即提示新版本。
