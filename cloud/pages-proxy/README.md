# Cloudflare Pages 试用入口

地址：<https://jiangdong-weekly-dashboard-pages-trial.pages.dev/>

此入口通过 Pages Function 的 `DASHBOARD` service binding 转发至生产 Worker。后端继续使用 GitHub 仓库的 `data/reports.json` 和 `data/attachments/`；网页编辑会写回 GitHub。`workers.dev` 原入口仍保留。

Pages 项目名为 `jiangdong-weekly-dashboard-pages-trial`。生产和预览环境都须绑定 `DASHBOARD` → Worker `jiangdong-weekly-dashboard`（production）。入口代码在 `_worker.js`。

Cloudflare Access 应单独保护本 Pages 主机的 `/editor`、`/editor/*`、`/api/write/*`，允许登录邮箱 `2978357684@qq.com`。后端 `ACCESS_AUD` 包含原 Worker 和 Pages 两个 Access 应用的 AUD，且仍须校验 JWT 签名及登录邮箱。请勿移除这些路径的 Access 规则。

更新入口代码时，可用项目根目录已安装的 `cf` CLI 创建 Pages 部署，并传入 `_worker.js`、空 manifest `{}`、分支 `main`。这个入口是无自购域名的试用方案；`pages.dev` 在中国大陆不同网络上的可达性会变化，不能保证全境稳定。
