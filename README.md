<div align="center">

# Katelya-TGBed

> 免费图片/文件托管解决方案，基于 Cloudflare Pages，支持多种存储后端

[English](README-EN.md) | **中文**

<br>

![GitHub stars](https://img.shields.io/github/stars/katelya77/Katelya-TGBed?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/katelya77/Katelya-TGBed?style=flat-square)
![GitHub license](https://img.shields.io/github/license/katelya77/Katelya-TGBed?style=flat-square)

</div>

---

## 效果图

<table>
  <tr>
    <td width="50%">
      <img src="demo/登录页面.webp" alt="登录页面" style="width:100%">
    </td>
    <td width="50%">
      <img src="demo/首页上传.webp" alt="首页上传" style="width:100%">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="demo/后台面板.webp" alt="后台面板" style="width:100%">
    </td>
    <td width="50%">
      <img src="demo/视频预览.webp" alt="视频预览" style="width:100%">
    </td>
  </tr>
</table>

## 功能特性

- **无限存储** - 不限数量的图片和文件上传
- **完全免费** - 托管于 Cloudflare，免费额度内零成本
- **免费域名** - 使用 `*.pages.dev` 二级域名，也支持自定义域名
- **多存储后端** - 支持 Telegram、Cloudflare R2、S3 兼容存储、Discord、HuggingFace
- **内容审核** - 可选的图片审核 API，自动屏蔽不良内容
- **多格式支持** - 图片、视频、音频、文档、压缩包等
- **在线预览** - 支持图片、视频、音频、文档（pdf、docx、txt）格式的预览
- **分片上传** - 支持最大 100MB 文件（配合 R2/S3）
- **访客上传** - 可选的访客上传功能，支持文件大小和每日次数限制
- **多种视图** - 网格、列表、瀑布流多种管理界面
- **存储分类** - 直观区分不同存储后端的文件

---

## 快速部署

### 前置要求

- Cloudflare 账户
- Telegram 账户（如使用 Telegram 存储）

### 第一步：获取 Telegram 凭据

1. **获取 Bot Token**
   - 向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`
   - 按提示创建机器人，获得 `BOT_TOKEN`

2. **创建频道并添加机器人**
   - 创建一个新的 Telegram 频道
   - 将机器人添加为频道管理员

3. **获取 Chat ID**
   - 向 [@VersaToolsBot](https://t.me/VersaToolsBot) 或 [@GetTheirIDBot](https://t.me/GetTheirIDBot) 发送消息获取频道 ID

### 第二步：部署到 Cloudflare

1. **Fork 本仓库**

2. **创建 Pages 项目**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
   - 进入 `Workers 和 Pages` → `创建应用程序` → `Pages` → `连接到 Git`
   - 选择 Fork 的仓库，点击部署

3. **配置环境变量**
   - 进入项目 `设置` → `环境变量`
   - 添加必需变量：

| 变量名 | 说明 | 必需 |
| :--- | :--- | :---: |
| `TG_Bot_Token` | Telegram Bot Token | ✅ |
| `TG_Chat_ID` | Telegram 频道 ID | ✅ |
| `BASIC_USER` | 管理后台用户名 | 可选 |
| `BASIC_PASS` | 管理后台密码 | 可选 |

**重新部署** - 修改环境变量后需重新部署生效

---

## 存储配置

### KV 存储（图片管理，必需）

启用图片管理功能需要配置 KV：

1. 进入 Cloudflare Dashboard → `Workers 和 Pages` → `KV`
2. 点击 `创建命名空间`，命名为 `katelya-tgbed`
3. 进入 Pages 项目 → `设置` → `函数` → `KV 命名空间绑定`
4. 添加绑定：变量名 `img_url`，选择创建的命名空间
5. 重新部署项目

### R2 存储（大文件支持，可选）

配置 R2 可支持最大 100MB 文件上传：

1. **创建存储桶**
   - Cloudflare Dashboard → `R2 对象存储` → `创建存储桶`
   - 命名为 `katelya-files`

2. **绑定到项目**
   - Pages 项目 → `设置` → `函数` → `R2 存储桶绑定`
   - 变量名 `R2_BUCKET`，选择存储桶

3. **启用 R2**
   - `设置` → `环境变量` → 添加 `USE_R2` = `true`
   - 重新部署

### S3 兼容存储（可选）

支持任何 S3 兼容的对象存储服务，包括 AWS S3、MinIO、BackBlaze B2、阿里云 OSS 等。

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `S3_ENDPOINT` | S3 服务端点 URL | `https://s3.us-east-1.amazonaws.com` |
| `S3_REGION` | 区域 | `us-east-1` |
| `S3_ACCESS_KEY_ID` | 访问密钥 ID | `AKIA...` |
| `S3_SECRET_ACCESS_KEY` | 秘密访问密钥 | `wJalr...` |
| `S3_BUCKET` | 存储桶名称 | `my-filebed` |

**不同服务商的 Endpoint 示例：**

| 服务商 | Endpoint 格式 | Region |
| :--- | :--- | :--- |
| AWS S3 | `https://s3.{region}.amazonaws.com` | `us-east-1` 等 |
| MinIO | `https://minio.example.com:9000` | `us-east-1` |
| BackBlaze B2 | `https://s3.{region}.backblazeb2.com` | `us-west-004` 等 |
| 阿里云 OSS | `https://oss-{region}.aliyuncs.com` | `cn-hangzhou` 等 |
| Cloudflare R2 | `https://{account_id}.r2.cloudflarestorage.com` | `auto` |

**部署步骤：**

1. 在你的 S3 服务商创建存储桶
2. 获取 Access Key ID 和 Secret Access Key
3. 在 Cloudflare Pages 项目中添加上述环境变量
4. 重新部署，前端将自动显示 S3 存储选项

### Discord 存储（可选）

通过 Discord 频道存储文件，支持 Webhook 和 Bot 两种方式。

> **注意：** Discord 附件 URL 会在约 24 小时后过期。本项目通过代理方式提供文件下载，每次请求时自动刷新 URL。因此即使使用 Webhook 上传，也需要配置 Bot Token 用于文件获取。

**环境变量：**

| 变量名 | 说明 | 必需 |
| :--- | :--- | :---: |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL（推荐用于上传） | 二选一 |
| `DISCORD_BOT_TOKEN` | Discord Bot Token（用于获取和删除文件） | 推荐 |
| `DISCORD_CHANNEL_ID` | Discord 频道 ID（Bot 模式上传时需要） | Bot 模式 |

**Webhook 方式部署（推荐）：**

1. 在 Discord 服务器中，进入频道设置 → 集成 → Webhook
2. 创建新的 Webhook，复制 Webhook URL
3. 在 Cloudflare Pages 添加环境变量 `DISCORD_WEBHOOK_URL`
4. （推荐）同时创建 Discord Bot 并添加 `DISCORD_BOT_TOKEN`，用于文件获取和删除
5. 重新部署

**Bot 方式部署：**

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用
2. 在 Bot 标签页创建 Bot，获取 Token
3. 在 OAuth2 → URL Generator 中，选择 `bot` scope 和 `Send Messages`、`Attach Files`、`Read Message History` 权限
4. 使用生成的 URL 邀请 Bot 到你的服务器
5. 在 Cloudflare Pages 添加 `DISCORD_BOT_TOKEN` 和 `DISCORD_CHANNEL_ID`
6. 重新部署

**限制：**
- 无 Boost 服务器：25MB/文件
- Level 2 Boost：50MB/文件
- Level 3 Boost：100MB/文件

### HuggingFace 存储（可选）

使用 HuggingFace Datasets API 存储文件。文件以 git commit 的形式保存在 Dataset 仓库中。

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `HF_TOKEN` | HuggingFace 写入权限 Token | `hf_xxxxxxxxxxxx` |
| `HF_REPO` | Dataset 仓库 ID | `username/my-filebed` |

**部署步骤：**

1. 注册 [HuggingFace](https://huggingface.co) 账户
2. 创建新的 Dataset 仓库（Settings → New Dataset）
3. 前往 [Settings → Access Tokens](https://huggingface.co/settings/tokens) 创建 Token（需要 Write 权限）
4. 在 Cloudflare Pages 添加 `HF_TOKEN` 和 `HF_REPO` 环境变量
5. 重新部署

**限制：**
- 普通上传（base64）：约 35MB/文件
- LFS 上传：最大 50GB/文件
- 免费用户仓库总大小：约 50GB

---

## 访客上传功能

允许未登录用户上传文件，站长可自行配置是否开启及限制规则。

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `GUEST_UPLOAD` | 启用访客上传 | `false` |
| `GUEST_MAX_FILE_SIZE` | 访客单文件最大大小（字节） | `5242880`（5MB） |
| `GUEST_DAILY_LIMIT` | 访客每日上传次数限制（按 IP 计） | `10` |

**启用方式：**

1. 在环境变量中设置 `GUEST_UPLOAD` = `true`
2. 按需调整 `GUEST_MAX_FILE_SIZE` 和 `GUEST_DAILY_LIMIT`
3. 确保已配置 `BASIC_USER` 和 `BASIC_PASS`（否则无访客/管理员区分）
4. 重新部署

**功能说明：**
- 访客可在首页直接上传文件，无需登录
- 访客有单文件大小限制和每日上传次数限制
- 访客不能使用分片上传和高级存储选项（S3/Discord/HuggingFace）
- 访客不能访问管理后台和图片浏览页
- 限制基于访客 IP 地址，每日自动重置

---

## 高级配置

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `ModerateContentApiKey` | 图片审核 API Key（从 [moderatecontent.com](https://moderatecontent.com) 获取） | - |
| `WhiteList_Mode` | 白名单模式，仅白名单图片可加载 | `false` |
| `USE_R2` | 启用 R2 存储 | `false` |
| `disable_telemetry` | 禁用遥测 | - |

---

## 页面说明

| 页面 | 路径 | 说明 |
| :--- | :--- | :--- |
| 首页/上传 | `/` | 批量上传、拖拽、粘贴上传 |
| 图片浏览 | `/gallery.html` | 图片网格浏览 |
| 管理后台 | `/admin.html` | 文件管理、黑白名单 |
| 文件预览 | `/preview.html` | 多格式文件预览 |
| 登录页 | `/login.html` | 后台登录 |

---

## 使用限制

**Cloudflare 免费额度：**

- 每日 100,000 次请求
- KV 每日 1,000 次写入、100,000 次读取、1,000 次列出
- 超出后需升级付费计划（$5/月起）

**各存储后端文件大小限制：**

| 存储后端 | 单文件最大大小 |
| :--- | :--- |
| Telegram | 20MB |
| Cloudflare R2 | 100MB（分片上传） |
| S3 兼容存储 | 100MB（分片上传） |
| Discord（无 Boost） | 25MB |
| Discord（Level 2+） | 50-100MB |
| HuggingFace | 35MB（普通）/ 50GB（LFS） |

---

## 所有环境变量参考

| 变量名 | 说明 | 必需 |
| :--- | :--- | :---: |
| `TG_Bot_Token` | Telegram Bot Token | ✅ |
| `TG_Chat_ID` | Telegram 频道 ID | ✅ |
| `BASIC_USER` | 管理后台用户名 | 可选 |
| `BASIC_PASS` | 管理后台密码 | 可选 |
| `USE_R2` | 启用 R2 存储 | 可选 |
| `S3_ENDPOINT` | S3 端点 URL | 可选 |
| `S3_REGION` | S3 区域 | 可选 |
| `S3_ACCESS_KEY_ID` | S3 访问密钥 | 可选 |
| `S3_SECRET_ACCESS_KEY` | S3 秘密密钥 | 可选 |
| `S3_BUCKET` | S3 存储桶名 | 可选 |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL | 可选 |
| `DISCORD_BOT_TOKEN` | Discord Bot Token | 可选 |
| `DISCORD_CHANNEL_ID` | Discord 频道 ID | 可选 |
| `HF_TOKEN` | HuggingFace Token | 可选 |
| `HF_REPO` | HuggingFace 仓库 ID | 可选 |
| `GUEST_UPLOAD` | 启用访客上传 | 可选 |
| `GUEST_MAX_FILE_SIZE` | 访客文件大小限制（字节） | 可选 |
| `GUEST_DAILY_LIMIT` | 访客每日上传次数 | 可选 |
| `ModerateContentApiKey` | 图片审核 API Key | 可选 |
| `WhiteList_Mode` | 白名单模式 | 可选 |
| `disable_telemetry` | 禁用遥测 | 可选 |

---

## 相关链接

- [Cloudflare Pages 文档](https://developers.cloudflare.com/pages/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [问题反馈](https://github.com/katelya77/Katelya-TGBed/issues)

---

## 致谢

本项目参考了以下开源项目：

- [Telegraph-Image](https://github.com/cf-pages/Telegraph-Image) - 原始灵感来源

---

## 许可证

MIT License

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=katelya77/Katelya-TGBed&type=Date)](https://star-history.com/#katelya77/Katelya-TGBed&Date)
