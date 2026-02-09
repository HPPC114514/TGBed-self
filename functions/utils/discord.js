/**
 * Discord 存储工具模块
 * 支持 Webhook 和 Bot 两种上传方式
 * 文件通过代理方式提供下载（Discord CDN URL 会过期）
 */

/**
 * 上传文件到 Discord
 * 优先使用 Webhook，其次使用 Bot
 * @param {ArrayBuffer} fileBuffer - 文件内容
 * @param {string} filename - 文件名
 * @param {string} contentType - MIME 类型
 * @param {object} env - 环境变量
 * @returns {{ success, channelId, messageId, attachmentId, error }}
 */
export async function uploadToDiscord(fileBuffer, filename, contentType, env) {
    if (env.DISCORD_WEBHOOK_URL) {
        return await uploadViaWebhook(fileBuffer, filename, contentType, env.DISCORD_WEBHOOK_URL);
    }
    if (env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID) {
        return await uploadViaBot(fileBuffer, filename, contentType, env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID);
    }
    return { success: false, error: 'Discord 未配置 Webhook URL 或 Bot Token' };
}

/**
 * 通过 Webhook 上传
 */
async function uploadViaWebhook(fileBuffer, filename, contentType, webhookUrl) {
    try {
        const formData = new FormData();
        formData.append('files[0]', new Blob([fileBuffer], { type: contentType }), filename);
        formData.append('payload_json', JSON.stringify({
            content: '',
            attachments: [{ id: 0, filename }]
        }));

        // ?wait=true 确保返回完整消息对象
        const response = await fetch(`${webhookUrl}?wait=true`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err.message || `HTTP ${response.status}` };
        }

        const message = await response.json();
        const attachment = message.attachments?.[0];

        if (!attachment) {
            return { success: false, error: '未获取到附件信息' };
        }

        return {
            success: true,
            channelId: message.channel_id,
            messageId: message.id,
            attachmentId: attachment.id,
            filename: attachment.filename,
            size: attachment.size,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 通过 Bot 上传
 */
async function uploadViaBot(fileBuffer, filename, contentType, botToken, channelId) {
    try {
        const formData = new FormData();
        formData.append('files[0]', new Blob([fileBuffer], { type: contentType }), filename);
        formData.append('payload_json', JSON.stringify({
            content: '',
            attachments: [{ id: 0, filename }]
        }));

        const response = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bot ${botToken}` },
                body: formData
            }
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err.message || `HTTP ${response.status}` };
        }

        const message = await response.json();
        const attachment = message.attachments?.[0];

        if (!attachment) {
            return { success: false, error: '未获取到附件信息' };
        }

        return {
            success: true,
            channelId: message.channel_id,
            messageId: message.id,
            attachmentId: attachment.id,
            filename: attachment.filename,
            size: attachment.size,
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 获取 Discord 文件的最新 URL（通过消息 API 刷新）
 * Discord 附件 URL 约 24 小时过期，需要重新获取
 */
export async function getDiscordFileUrl(channelId, messageId, env) {
    const botToken = env.DISCORD_BOT_TOKEN;
    if (!botToken) {
        throw new Error('需要 DISCORD_BOT_TOKEN 才能获取文件');
    }

    const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
        { headers: { 'Authorization': `Bot ${botToken}` } }
    );

    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Discord API error: ${response.status}`);
    }

    const message = await response.json();
    const attachment = message.attachments?.[0];

    if (!attachment) return null;

    return {
        url: attachment.url,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type
    };
}

/**
 * 删除 Discord 消息（及其附件）
 */
export async function deleteDiscordMessage(channelId, messageId, env) {
    const botToken = env.DISCORD_BOT_TOKEN;
    if (!botToken) {
        console.warn('No DISCORD_BOT_TOKEN, cannot delete Discord message');
        return false;
    }

    try {
        const response = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${botToken}` }
            }
        );

        return response.ok || response.status === 204;
    } catch (error) {
        console.error('Discord delete error:', error);
        return false;
    }
}

/**
 * 检查 Discord 连接状态
 */
export async function checkDiscordConnection(env) {
    // 检查 Webhook
    if (env.DISCORD_WEBHOOK_URL) {
        try {
            // GET webhook URL 返回 webhook 信息
            const response = await fetch(env.DISCORD_WEBHOOK_URL);
            if (response.ok) {
                const data = await response.json();
                return {
                    connected: true,
                    mode: 'webhook',
                    name: data.name,
                    channelId: data.channel_id
                };
            }
        } catch (e) {
            // fall through
        }
    }

    // 检查 Bot
    if (env.DISCORD_BOT_TOKEN) {
        try {
            const response = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });
            if (response.ok) {
                const data = await response.json();
                return {
                    connected: true,
                    mode: 'bot',
                    name: data.username,
                    channelId: env.DISCORD_CHANNEL_ID
                };
            }
        } catch (e) {
            // fall through
        }
    }

    return { connected: false };
}
