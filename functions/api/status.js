/**
 * 系统状态检查 API
 * GET /api/status
 * 返回 Telegram、KV、R2、S3、Discord、HuggingFace 等服务的连接状态
 */
import { createS3Client } from '../utils/s3client.js';
import { checkDiscordConnection } from '../utils/discord.js';
import { checkHuggingFaceConnection } from '../utils/huggingface.js';
import { getGuestConfig } from '../utils/guest.js';

export async function onRequestGet(context) {
  const { env } = context;

  const status = {
    telegram: { connected: false, message: '未配置' },
    kv: { connected: false, message: '未配置' },
    r2: { connected: false, message: '未配置', enabled: false },
    s3: { connected: false, message: '未配置', enabled: false },
    discord: { connected: false, message: '未配置', enabled: false },
    huggingface: { connected: false, message: '未配置', enabled: false },
    auth: { enabled: false, message: '未启用' },
    guestUpload: getGuestConfig(env)
  };

  // 并行检查所有服务状态
  const checks = [];

  // 检查 Telegram 配置
  if (env.TG_Bot_Token && env.TG_Chat_ID) {
    checks.push(
      fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/getMe`)
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            status.telegram = {
              connected: true,
              message: `已连接 - @${data.result.username}`,
              botName: data.result.first_name,
              botUsername: data.result.username
            };
          } else {
            status.telegram = { connected: false, message: `连接失败: ${data.description}` };
          }
        })
        .catch(e => { status.telegram = { connected: false, message: `连接错误: ${e.message}` }; })
    );
  }

  // 检查 KV 配置
  if (env.img_url) {
    checks.push(
      env.img_url.list({ limit: 1 })
        .then(result => {
          status.kv = {
            connected: true,
            message: '已连接',
            hasData: result.keys && result.keys.length > 0
          };
        })
        .catch(e => { status.kv = { connected: false, message: `连接错误: ${e.message}` }; })
    );
  }

  // 检查 R2 配置
  if (env.R2_BUCKET) {
    checks.push(
      env.R2_BUCKET.list({ limit: 1 })
        .then(result => {
          status.r2 = {
            connected: true,
            enabled: true,
            message: '已启用',
            hasData: result.objects && result.objects.length > 0
          };
        })
        .catch(e => { status.r2 = { connected: false, enabled: false, message: `连接错误: ${e.message}` }; })
    );
  }

  // 检查 S3 配置
  if (env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET) {
    checks.push(
      (async () => {
        try {
          const s3 = createS3Client(env);
          const connected = await s3.checkConnection();
          status.s3 = {
            connected,
            enabled: connected,
            message: connected ? `已连接 - ${env.S3_BUCKET}` : '连接失败'
          };
        } catch (e) {
          status.s3 = { connected: false, enabled: false, message: `连接错误: ${e.message}` };
        }
      })()
    );
  }

  // 检查 Discord 配置
  if (env.DISCORD_WEBHOOK_URL || env.DISCORD_BOT_TOKEN) {
    checks.push(
      checkDiscordConnection(env)
        .then(result => {
          status.discord = {
            connected: result.connected,
            enabled: result.connected,
            message: result.connected
              ? `已连接 (${result.mode}) - ${result.name}`
              : '连接失败',
            mode: result.mode
          };
        })
        .catch(e => { status.discord = { connected: false, enabled: false, message: `连接错误: ${e.message}` }; })
    );
  }

  // 检查 HuggingFace 配置
  if (env.HF_TOKEN && env.HF_REPO) {
    checks.push(
      checkHuggingFaceConnection(env)
        .then(result => {
          status.huggingface = {
            connected: result.connected,
            enabled: result.connected,
            message: result.connected
              ? `已连接 - ${result.repoId}${result.isPrivate ? ' (私有)' : ''}`
              : '连接失败'
          };
        })
        .catch(e => { status.huggingface = { connected: false, enabled: false, message: `连接错误: ${e.message}` }; })
    );
  }

  // 检查认证配置
  if (env.BASIC_USER && env.BASIC_PASS) {
    status.auth = {
      enabled: true,
      message: '已启用密码认证'
    };
  }

  // 等待所有检查完成
  await Promise.allSettled(checks);

  return new Response(JSON.stringify(status, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
