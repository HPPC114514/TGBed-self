import { errorHandling, telemetryData } from "./utils/middleware";
import { checkAuthentication, isAuthRequired } from "./utils/auth.js";
import { checkGuestUpload, incrementGuestCount } from "./utils/guest.js";
import { createS3Client } from "./utils/s3client.js";
import { uploadToDiscord } from "./utils/discord.js";
import { uploadToHuggingFace } from "./utils/huggingface.js";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        // --- 访客权限检查 ---
        const isAdmin = await isUserAuthenticated(context);
        if (!isAdmin) {
            const guestCheck = await checkGuestUpload(request, env, uploadFile.size);
            if (!guestCheck.allowed) {
                return new Response(
                    JSON.stringify({ error: guestCheck.reason }),
                    { status: guestCheck.status || 403, headers: { 'Content-Type': 'application/json' } }
                );
            }
        }

        // 获取存储模式 - 默认使用 telegram
        const storageMode = formData.get('storageMode') || 'telegram';

        let result;

        // --- 根据存储模式分发 ---
        if (storageMode === 'r2') {
            if (!env.R2_BUCKET) {
                return errorResponse('R2 未配置或未启用，无法上传');
            }
            result = await uploadToR2(uploadFile, fileName, fileExtension, env);
        } else if (storageMode === 's3') {
            if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID) {
                return errorResponse('S3 未配置，无法上传');
            }
            result = await uploadToS3(uploadFile, fileName, fileExtension, env);
        } else if (storageMode === 'discord') {
            if (!env.DISCORD_WEBHOOK_URL && !env.DISCORD_BOT_TOKEN) {
                return errorResponse('Discord 未配置，无法上传');
            }
            result = await uploadToDiscordStorage(uploadFile, fileName, fileExtension, env);
        } else if (storageMode === 'huggingface') {
            if (!env.HF_TOKEN || !env.HF_REPO) {
                return errorResponse('HuggingFace 未配置，无法上传');
            }
            result = await uploadToHFStorage(uploadFile, fileName, fileExtension, env);
        } else {
            // 默认上传到 Telegram
            result = await uploadToTelegramStorage(uploadFile, fileName, fileExtension, env);
        }

        // 如果返回的已经是 Response 对象，直接返回
        if (result instanceof Response) {
            // 访客计数（仅成功时）
            if (!isAdmin) {
                const status = result.status;
                if (status >= 200 && status < 300) {
                    await incrementGuestCount(request, env);
                }
            }
            return result;
        }

        return result;
    } catch (error) {
        console.error('Upload error:', error);
        return errorResponse(error.message);
    }
}

// 检查用户是否已认证（管理员）
async function isUserAuthenticated(context) {
    const { env } = context;
    if (!isAuthRequired(env)) return true; // 无需认证时视为管理员
    try {
        const auth = await checkAuthentication(context);
        return auth.authenticated;
    } catch {
        return false;
    }
}

function errorResponse(message, status = 500) {
    return new Response(
        JSON.stringify({ error: message }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

// --- Telegram 上传 ---
async function uploadToTelegramStorage(uploadFile, fileName, fileExtension, env) {
    const telegramFormData = new FormData();
    telegramFormData.append("chat_id", env.TG_Chat_ID);

    let apiEndpoint;
    if (uploadFile.type.startsWith('image/')) {
        telegramFormData.append("photo", uploadFile);
        apiEndpoint = 'sendPhoto';
    } else if (uploadFile.type.startsWith('audio/')) {
        telegramFormData.append("audio", uploadFile);
        apiEndpoint = 'sendAudio';
    } else if (uploadFile.type.startsWith('video/')) {
        telegramFormData.append("video", uploadFile);
        apiEndpoint = 'sendVideo';
    } else {
        telegramFormData.append("document", uploadFile);
        apiEndpoint = 'sendDocument';
    }

    const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

    if (!result.success) {
        throw new Error(result.error);
    }

    const fileId = getFileId(result.data);
    const messageId = result.messageId || result.data?.result?.message_id;

    if (!fileId) {
        throw new Error('Failed to get file ID');
    }

    if (env.img_url) {
        await env.img_url.put(`${fileId}.${fileExtension}`, "", {
            metadata: {
                TimeStamp: Date.now(),
                ListType: "None",
                Label: "None",
                liked: false,
                fileName: fileName,
                fileSize: uploadFile.size,
                storageType: 'telegram',
                telegramMessageId: messageId || undefined,
            }
        });
    }

    return new Response(
        JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}` }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 3;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        // 使用 AbortController 添加 30 秒超时
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
            response = await fetch(apiUrl, {
                method: "POST",
                body: formData,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData, messageId: responseData?.result?.message_id };
        }

        // 处理 429 速率限制
        if (response.status === 429) {
            const retryAfter = responseData.parameters?.retry_after || 5;
            console.log(`Rate limited, retrying after ${retryAfter}s...`);
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
            }
            return { success: false, error: `速率限制，请 ${retryAfter} 秒后重试` };
        }

        // 处理 413 文件过大
        if (response.status === 413) {
            return { success: false, error: 'Telegram 限制：文件大小不能超过 20MB' };
        }

        // 图片/音频上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && (apiEndpoint === 'sendPhoto' || apiEndpoint === 'sendAudio')) {
            console.log(`Retrying ${apiEndpoint} as document...`);
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            const fileField = apiEndpoint === 'sendPhoto' ? 'photo' : 'audio';
            newFormData.append('document', formData.get(fileField));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Telegram API request timed out');
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
                return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
            }
            return { success: false, error: '上传超时，请重试' };
        }

        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            // 指数退避: 1s, 2s, 4s
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: '网络错误，请检查网络连接后重试' };
    }
}

// --- R2 上传 ---
async function uploadToR2(file, fileName, fileExtension, env) {
    try {
        const fileId = `r2_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const objectKey = `${fileId}.${fileExtension}`;
        const arrayBuffer = await file.arrayBuffer();

        await env.R2_BUCKET.put(objectKey, arrayBuffer, {
            httpMetadata: { contentType: file.type },
            customMetadata: { fileName: fileName, uploadTime: Date.now().toString() }
        });

        if (env.img_url) {
            await env.img_url.put(`r2:${objectKey}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None", Label: "None", liked: false,
                    fileName: fileName, fileSize: file.size,
                    storageType: 'r2', r2Key: objectKey
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/r2:${objectKey}` }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('R2 upload error:', error);
        return errorResponse('R2 上传失败: ' + error.message);
    }
}

// --- S3 上传 ---
async function uploadToS3(file, fileName, fileExtension, env) {
    try {
        const s3 = createS3Client(env);
        const fileId = `s3_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const objectKey = `${fileId}.${fileExtension}`;
        const arrayBuffer = await file.arrayBuffer();

        await s3.putObject(objectKey, arrayBuffer, {
            contentType: file.type || 'application/octet-stream',
            metadata: { 'x-amz-meta-filename': fileName, 'x-amz-meta-uploadtime': Date.now().toString() }
        });

        if (env.img_url) {
            await env.img_url.put(`s3:${objectKey}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None", Label: "None", liked: false,
                    fileName: fileName, fileSize: file.size,
                    storageType: 's3', s3Key: objectKey
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/s3:${objectKey}` }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('S3 upload error:', error);
        return errorResponse('S3 上传失败: ' + error.message);
    }
}

// --- Discord 上传 ---
async function uploadToDiscordStorage(file, fileName, fileExtension, env) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await uploadToDiscord(arrayBuffer, fileName, file.type, env);

        if (!result.success) {
            return errorResponse('Discord 上传失败: ' + result.error);
        }

        const fileId = `discord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const kvKey = `discord:${fileId}.${fileExtension}`;

        if (env.img_url) {
            await env.img_url.put(kvKey, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None", Label: "None", liked: false,
                    fileName: fileName, fileSize: file.size,
                    storageType: 'discord',
                    discordChannelId: result.channelId,
                    discordMessageId: result.messageId,
                    discordAttachmentId: result.attachmentId,
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${kvKey}` }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Discord upload error:', error);
        return errorResponse('Discord 上传失败: ' + error.message);
    }
}

// --- HuggingFace 上传 ---
async function uploadToHFStorage(file, fileName, fileExtension, env) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const fileId = `hf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const hfPath = `uploads/${fileId}.${fileExtension}`;

        const result = await uploadToHuggingFace(arrayBuffer, hfPath, fileName, env);

        if (!result.success) {
            return errorResponse('HuggingFace 上传失败: ' + result.error);
        }

        const kvKey = `hf:${fileId}.${fileExtension}`;

        if (env.img_url) {
            await env.img_url.put(kvKey, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None", Label: "None", liked: false,
                    fileName: fileName, fileSize: file.size,
                    storageType: 'huggingface',
                    hfPath: hfPath
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${kvKey}` }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('HuggingFace upload error:', error);
        return errorResponse('HuggingFace 上传失败: ' + error.message);
    }
}