# HALCYON｜Vercel 项目源码

这是 HALCYON 个人博客的 Vercel 部署版源码。首页标题固定为 **HALCYON**，保留黑白主题、系统主题跟随、首页 Clawd 动画、响应式导航、标签筛选、文章翻页式详情层、评论区 Clawd 动画、返回顶部按钮、文章管理入口与 404 吉祥物。没有提供的个人简介和文章正文不会由项目虚构；页面在内容为空时会显示完整装饰布局和状态提示，不会留下纯白空块。

## 文件说明

- `public/`：网站页面、样式、Clawd 素材。
- `api/posts.js`：文章列表、文章详情和后台管理 API。
- `api/twikoo.js`：Twikoo 官方 Vercel 适配器入口。
- `vercel.json`：Vercel 构建、函数、安全响应头设置，并将 `/api/twikoo/*` 下的评论请求统一转发到 Twikoo 处理函数；文章请求仍走 `/api/posts`。
- `scripts/check.mjs`：部署前语法、配置、资源路径检查，并调用单元测试。
- `scripts/test-api.cjs` 与 `scripts/test-twikoo-adapter.cjs`：文章 API 和 Twikoo 入口适配器的模拟测试。
- `代码审计与测试报告.md`：按文件记录的检查结果、已知边界和线上验收项目。

## 部署前需要准备的服务

评论与文章管理需要数据库。此项目采用 MongoDB Atlas + Vercel Functions；评论系统使用 Twikoo，不另造一套评论后端。请不要把数据库连接串或管理员令牌发到聊天、截图或公开仓库中。

在 MongoDB Atlas 中创建数据库用户与集群后，复制连接串。建议连接串中的数据库路径使用 `twikoo`，例如格式为 `mongodb+srv://用户名:密码@集群地址/twikoo?...`；这只是格式示例，不是可直接使用的连接串。请在 Atlas 网络访问设置中按实际部署环境配置访问规则。

在 Vercel 项目设置中打开 **Settings → Environment Variables**，添加以下变量，并选择 Production（建议 Preview 也配置，便于测试）：

| 变量名 | 用途 | 值 |
|---|---|---|
| `MONGODB_URI` | Twikoo 评论数据库的连接串；文章 API 也通过它连接同一 MongoDB 集群 | MongoDB Atlas 提供的真实连接串（保密） |
| `BLOG_DB_NAME` | 文章集合所在数据库 | `halcyon_blog` |
| `BLOG_ADMIN_TOKEN` | 文章后台管理员密钥 | 自己生成的长随机密钥，切勿写进代码 |

保存变量后，在 Vercel 的 Deployments 页面重新部署一次，让新变量生效。没有配置数据库时，首页静态视觉仍可打开，但评论和文章管理不可能完整工作；请不要把“网页打开”误认为“后台已连通”。

## 用 GitHub 将项目连接到 Vercel（无需手写代码）

1. 解压这个 ZIP。保留里面的 `api`、`public`、`scripts` 文件夹，以及 `package.json`、`vercel.json` 等根目录文件。不要只上传 `public` 文件夹。
2. 在 GitHub 网页创建一个新仓库。仓库可以保持 Private，无需为了部署改成 Public。
3. 进入新仓库，选择 **Add file → Upload files**，把解压后的项目文件上传进去；确认 `api/`、`public/`、`scripts/` 是仓库根目录下的文件夹，而不是多套了一层同名项目文件夹。提交上传。
4. 在 Vercel 控制台选择 **Add New → Project**，导入刚才的 GitHub 仓库。Framework Preset 选 **Other**；Build Command 使用 `npm run build`；Output Directory 使用 `public`；Install Command 使用 `npm install`。如果页面自动识别了 `vercel.json`，优先保持配置文件中的设置。
5. 在创建项目时或创建后，按上表添加环境变量，再重新部署。
6. 部署成功后先打开网站首页确认页面显示，再测试文章后台 `https://你的域名/#admin`。用 `BLOG_ADMIN_TOKEN` 的真实值登录。评论区要进入任意已发布文章详情后才会加载。客户端与服务器依赖版本已固定；评论 API 的子路径通过 Vercel rewrite 转发到 `api/twikoo.js`。

## 发布文章

项目没有预填虚构文章。数据库和环境变量配置完成后，打开网站地址并在末尾加 `#admin`，输入管理员令牌。后台可新建、编辑、发布/取消发布和删除文章；正文支持基础 Markdown。只有已发布文章会显示给访客。访客无需编写文章；他们只能按评论系统本身提供的方式发表评论。

## 检查命令

本项目内置的 `npm test`、`npm run check` 和 `npm run build` 会检查 JavaScript/module 语法、关键 HTML 引用与 ID、Vercel 重写/函数配置、评论客户端与服务端版本、前端文件/API 路径，并运行 API 与 Twikoo 入口模拟测试。它们不是对真实 MongoDB 凭据、Vercel 云端运行环境或真实评论提交的端到端测试。上传前如有条件，可在本地运行：

```bash
npm install
npm test
npm run check
npm run build
```

## 已知边界与安全说明

- 评论核心功能、回复、评论管理与置顶能力以 Twikoo 当前版本及其管理面板为准。原需求中“每位访客必须通过已验证邮箱才能自行编辑/删除自己的评论”等细颗粒权限，并非这个项目通过前端样式就能强制实现的功能；不要仅凭访客输入了邮箱就认为邮箱已完成验证。需要严格满足该项时，必须先核实 Twikoo 当前版本是否提供对应的服务端验证和权限机制，不能靠浏览器端伪装实现。
- 网站不会向访客公开评论邮箱，也不会在源码中写入数据库密码或管理员令牌。
- `.env`、`.vercel/`、`node_modules/` 不应提交到仓库。
- 请在 Vercel 和 MongoDB Atlas 控制台查看部署日志与数据库连接状态。当前打包检查通过，不等于已经替你在云端部署或验证真实服务。
