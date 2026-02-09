import { createS3Client } from '../utils/s3client.js';
import { getDiscordFileUrl } from '../utils/discord.js';
import { getHuggingFaceFile } from '../utils/huggingface.js';

// MIME 类型映射表
const MIME_TYPES = {
    // 视频
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'ogg': 'video/ogg',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'm4v': 'video/x-m4v',
    'wmv': 'video/x-ms-wmv',
    'flv': 'video/x-flv',
    '3gp': 'video/3gpp',
    // 音频
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'aac': 'audio/aac',
    'm4a': 'audio/mp4',
    'wma': 'audio/x-ms-wma',
    'opus': 'audio/opus',
    'oga': 'audio/ogg',
    // 图片
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    // 文档
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // 文本
    'txt': 'text/plain',
    'html': 'text/html',
    'css': 'text/css',
    'js': 'text/javascript',
    'json': 'application/json',
    'xml': 'application/xml',
    'md': 'text/markdown',
    // 压缩
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
};

// 根据文件名获取 MIME 类型
function getMimeType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

// 判断是否是流媒体类型（需要 Range 支持）
function isStreamableType(mimeType) {
    return mimeType.startsWith('video/') || mimeType.startsWith('audio/');
}

// 添加 CORS 和通用响应头
function addCorsHeaders(headers) {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition');
    // 同时阻止 Cloudflare CDN 边缘缓存，防止删除后仍从边缘返回旧响应
    headers.set('CDN-Cache-Control', 'no-store');
    return headers;
}

// 处理 OPTIONS 预检请求
function handleOptions() {
    const headers = new Headers();
    addCorsHeaders(headers);
    headers.set('Access-Control-Max-Age', '86400');
    return new Response(null, { status: 204, headers });
}

// 解析 Range 请求头
function parseRangeHeader(rangeHeader, totalSize) {
    if (!rangeHeader) return null;
    
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) return null;
    
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
    
    // 处理后缀范围请求 (bytes=-500 表示最后 500 字节)
    if (!match[1] && match[2]) {
        start = Math.max(0, totalSize - parseInt(match[2], 10));
        end = totalSize - 1;
    }
    
    // 确保范围有效
    if (start >= totalSize || start < 0 || end < start) {
        return { invalid: true, totalSize };
    }
    
    end = Math.min(end, totalSize - 1);
    
    return { start, end, totalSize };
}

export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
        return handleOptions();
    }

    const url = new URL(request.url);
    let fileId = params.id;

    // 检查是否是 R2 存储的文件（以 r2: 开头）
    if (fileId.startsWith('r2:')) {
        return await handleR2File(context, fileId.substring(3)); // 移除 r2: 前缀
    }

    // 检查是否是 S3 存储的文件
    if (fileId.startsWith('s3:')) {
        return await handleS3File(context, fileId);
    }

    // 检查是否是 Discord 存储的文件
    if (fileId.startsWith('discord:')) {
        return await handleDiscordFile(context, fileId);
    }

    // 检查是否是 HuggingFace 存储的文件
    if (fileId.startsWith('hf:')) {
        return await handleHFFile(context, fileId);
    }

    // 先检查 KV 中是否有该文件的元数据，判断存储类型
    let record = null;
    let isR2Storage = false;
    let isS3Storage = false;
    let isDiscordStorage = false;
    let isHFStorage = false;

    if (env.img_url) {
        // 尝试多种前缀查找（兼容新旧 Key 格式）
        const prefixes = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', ''];
        for (const prefix of prefixes) {
            const key = `${prefix}${fileId}`;
            record = await env.img_url.getWithMetadata(key);
            if (record && record.metadata) {
                isR2Storage = record.metadata.storage === 'r2' || record.metadata.storageType === 'r2';
                isS3Storage = record.metadata.storageType === 's3';
                isDiscordStorage = record.metadata.storageType === 'discord';
                isHFStorage = record.metadata.storageType === 'huggingface';
                break;
            }
        }
    }

    // KV 门禁：如果 KV 可用但未找到文件记录，直接返回 404
    // 阻止已删除文件通过 CDN 缓存或 Telegram 直链继续被访问
    if (env.img_url && (!record || !record.metadata)) {
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Cache-Control', 'no-store, max-age=0');
        return new Response('File not found', { status: 404, headers });
    }

    // 如果是 R2 存储，从 R2 获取文件
    if (isR2Storage && env.R2_BUCKET) {
        const r2Key = record?.metadata?.r2Key || fileId;
        return await handleR2File(context, r2Key, record);
    }

    // 如果是 S3 存储
    if (isS3Storage) {
        return await handleS3File(context, fileId, record);
    }

    // 如果是 Discord 存储
    if (isDiscordStorage) {
        return await handleDiscordFile(context, fileId, record);
    }

    // 如果是 HuggingFace 存储
    if (isHFStorage) {
        return await handleHFFile(context, fileId, record);
    }
    
    // 从 Telegram 获取文件（原有逻辑）
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search
    let isTelegramBotFile = false;
    
    if (url.pathname.length > 39) { // Path length > 39 indicates file uploaded via Telegram Bot API
        isTelegramBotFile = true;
        const formdata = new FormData();
        formdata.append("file_id", url.pathname);

        const requestOptions = {
            method: "POST",
            body: formdata,
            redirect: "follow"
        };
        // /file/AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA.png
        //get the AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA
        console.log(url.pathname.split(".")[0].split("/")[2])
        const filePath = await getFilePath(env, url.pathname.split(".")[0].split("/")[2]);
        console.log(filePath)
        if (!filePath) {
            const headers = new Headers();
            addCorsHeaders(headers);
            return new Response('Failed to get file path from Telegram', { status: 500, headers });
        }
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    // 获取文件名和 MIME 类型
    const fileName = record?.metadata?.fileName || params.id;
    const mimeType = getMimeType(fileName);
    const rangeHeader = request.headers.get('Range');
    
    // 对于流媒体文件，使用增强的 Range 处理
    if (isStreamableType(mimeType) && rangeHeader) {
        return await handleStreamableFile(fileUrl, fileName, mimeType, rangeHeader, request);
    }

    // 构建请求头，透传 Range 请求
    const fetchHeaders = new Headers();
    if (rangeHeader) {
        fetchHeaders.set('Range', rangeHeader);
        console.log('Range request:', rangeHeader);
    }

    // 发起请求到 Telegram（禁用 Cloudflare 边缘缓存，确保删除后立即生效）
    const response = await fetch(fileUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: fetchHeaders,
        cf: { cacheTtl: 0, cacheEverything: false },
    });

    // If the response is not OK (excluding 206 Partial Content), return error
    if (!response.ok && response.status !== 206) {
        const errorHeaders = new Headers();
        addCorsHeaders(errorHeaders);
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: errorHeaders
        });
    }

    // Log response details
    console.log('Response status:', response.status, 'Range requested:', !!rangeHeader);

    // KV 记录已在前面的门禁中确认存在，直接使用
    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // Handle based on ListType and Label
    if (metadata.ListType === "White") {
        return createStreamResponse(response, metadata.fileName, mimeType, rangeHeader);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // Check if WhiteList_Mode is enabled
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // If no metadata or further actions required, moderate content and add to KV if needed
    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        console.log("Content marked as adult, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Error during content moderation: " + error.message);
            // Moderation failure should not affect user experience, continue processing
        }
    }

    // 已存在元数据，不再自动写入，避免删除后被重新创建

    // 使用流式响应返回文件
    return createStreamResponse(response, metadata.fileName, mimeType, rangeHeader);
}

// 创建响应，正确处理 Range 请求和 CORS
function createStreamResponse(upstreamResponse, fileName, mimeType, rangeHeader) {
    const headers = new Headers();
    
    // 添加 CORS 头
    addCorsHeaders(headers);
    
    // 设置正确的 Content-Type
    headers.set('Content-Type', mimeType);
    
    // 透传 Content-Length
    const contentLength = upstreamResponse.headers.get('Content-Length');
    if (contentLength) {
        headers.set('Content-Length', contentLength);
    }
    
    // 声明支持 Range 请求
    headers.set('Accept-Ranges', 'bytes');
    
    // 如果是 206 响应，透传 Content-Range
    if (upstreamResponse.status === 206) {
        const contentRange = upstreamResponse.headers.get('Content-Range');
        if (contentRange) {
            headers.set('Content-Range', contentRange);
        }
    }
    
    // 设置文件名
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    
    // 缓存控制（删除后立即生效，避免缓存继续访问）
    headers.set('Cache-Control', 'no-store, max-age=0');
    
    // 直接传递 body，Cloudflare Workers 会自动处理流式传输
    return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers
    });
}

// 处理流媒体文件（视频/音频），支持 Range 请求
async function handleStreamableFile(fileUrl, fileName, mimeType, rangeHeader, originalRequest) {
    console.log('Handling streamable file with Range:', rangeHeader);
    
    // 首先尝试透传 Range 请求
    const fetchHeaders = new Headers();
    fetchHeaders.set('Range', rangeHeader);
    
    let response = await fetch(fileUrl, {
        method: 'GET',
        headers: fetchHeaders,
        cf: { cacheTtl: 0, cacheEverything: false },
    });
    
    // 检查上游是否支持 Range 请求
    if (response.status === 206) {
        // 上游支持 Range，直接透传
        console.log('Upstream supports Range, status 206');
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        headers.set('Cache-Control', 'no-store, max-age=0');
        
        // 透传关键头
        const contentLength = response.headers.get('Content-Length');
        const contentRange = response.headers.get('Content-Range');
        
        if (contentLength) headers.set('Content-Length', contentLength);
        if (contentRange) headers.set('Content-Range', contentRange);
        
        return new Response(response.body, {
            status: 206,
            statusText: 'Partial Content',
            headers
        });
    }
    
    // 上游不支持 Range (返回 200)，需要自行实现分片
    // 这种情况下，我们需要先获取文件总大小
    console.log('Upstream does not support Range, implementing manually');
    
    const totalSize = parseInt(response.headers.get('Content-Length') || '0', 10);
    
    if (!totalSize) {
        // 无法获取文件大小，返回完整文件
        console.log('Cannot determine file size, returning full file');
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        headers.set('Cache-Control', 'no-store, max-age=0');
        
        return new Response(response.body, {
            status: 200,
            headers
        });
    }
    
    // 解析 Range 请求
    const range = parseRangeHeader(rangeHeader, totalSize);
    
    if (!range) {
        // Range 头无效，返回完整文件
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Content-Length', totalSize.toString());
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        headers.set('Cache-Control', 'no-store, max-age=0');
        
        return new Response(response.body, {
            status: 200,
            headers
        });
    }
    
    if (range.invalid) {
        // Range 不满足
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Range', `bytes */${range.totalSize}`);
        return new Response('Range Not Satisfiable', { status: 416, headers });
    }
    
    const { start, end } = range;
    const chunkSize = end - start + 1;
    
    console.log(`Manually slicing: bytes ${start}-${end}/${totalSize}`);
    
    // 读取完整文件并切片（这不是最优方案，但在上游不支持 Range 时是唯一选择）
    // 注意：这会消耗内存，大文件可能会有问题
    try {
        const arrayBuffer = await response.arrayBuffer();
        const slicedBuffer = arrayBuffer.slice(start, end + 1);
        
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Content-Length', chunkSize.toString());
        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        headers.set('Cache-Control', 'no-store, max-age=0');
        
        return new Response(slicedBuffer, {
            status: 206,
            statusText: 'Partial Content',
            headers
        });
    } catch (error) {
        console.error('Error slicing file:', error);
        const headers = new Headers();
        addCorsHeaders(headers);
        return new Response('Error processing file: ' + error.message, { status: 500, headers });
    }
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, {
            method: 'GET',
        });

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const responseData = await res.json();
        const { ok, result } = responseData;

        if (ok && result) {
            return result.file_path;
        } else {
            console.error('Error in response data:', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}

// R2 文件处理函数 - 支持 Range 请求
async function getR2RecordFromKV(env, r2Key) {
    if (!env.img_url) {
        return null;
    }

    const candidateKeys = [];
    if (r2Key.startsWith('r2:')) {
        candidateKeys.push(r2Key);
    } else {
        candidateKeys.push(`r2:${r2Key}`);
    }
    candidateKeys.push(r2Key);

    for (const key of [...new Set(candidateKeys)]) {
        const record = await env.img_url.getWithMetadata(key);
        if (record && record.metadata) {
            return record;
        }
    }

    return null;
}

async function handleR2File(context, r2Key, record = null) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
        return handleOptions();
    }
    
    if (!env.R2_BUCKET) {
        return new Response('R2 storage not configured', { status: 500 });
    }
    
    try {
        // 如果没有 record，尝试从 KV 获取
        if (!record || !record.metadata) {
            record = await getR2RecordFromKV(env, r2Key);
        }
        if (!record || !record.metadata) {
            const headers = new Headers();
            addCorsHeaders(headers);
            headers.set('Cache-Control', 'no-store, max-age=0');
            return new Response('File not found', { status: 404, headers });
        }
        
        // 检查访问控制
        if (record?.metadata?.ListType === 'Block' || record?.metadata?.Label === 'adult') {
            const referer = request.headers.get('Referer');
            const isAdmin = referer?.includes(`${url.origin}/admin`);
            if (!isAdmin) {
                const redirectUrl = referer 
                    ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" 
                    : `${url.origin}/block-img.html`;
                return Response.redirect(redirectUrl, 302);
            }
        }
        
        // 获取文件名和 MIME 类型
        const fileName = record?.metadata?.fileName || r2Key;
        const mimeType = getMimeType(fileName);
        
        // 解析 Range 请求头
        const rangeHeader = request.headers.get('Range');
        let object;
        let isPartialContent = false;
        let rangeStart, rangeEnd, totalSize;
        
        if (rangeHeader) {
            // 解析 Range: bytes=start-end
            const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
            if (match) {
                // 首先获取对象以得到总大小
                const headObject = await env.R2_BUCKET.head(r2Key);
                if (!headObject) {
                    return new Response('File not found in R2', { status: 404 });
                }
                totalSize = headObject.size;
                
                rangeStart = match[1] ? parseInt(match[1], 10) : 0;
                rangeEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
                
                // 确保范围有效
                if (rangeStart >= totalSize) {
                    const headers = new Headers();
                    addCorsHeaders(headers);
                    headers.set('Content-Range', `bytes */${totalSize}`);
                    return new Response('Range Not Satisfiable', { status: 416, headers });
                }
                
                rangeEnd = Math.min(rangeEnd, totalSize - 1);
                
                // 使用 R2 的 range 参数获取部分内容
                object = await env.R2_BUCKET.get(r2Key, {
                    range: { offset: rangeStart, length: rangeEnd - rangeStart + 1 }
                });
                isPartialContent = true;
                console.log(`R2 Range request: bytes=${rangeStart}-${rangeEnd}/${totalSize}`);
            }
        }
        
        // 如果不是 Range 请求，或 Range 解析失败，获取整个文件
        if (!object) {
            object = await env.R2_BUCKET.get(r2Key);
            if (!object) {
                return new Response('File not found in R2', { status: 404 });
            }
            totalSize = object.size;
        }
        
        // 构建响应头
        const headers = new Headers();
        addCorsHeaders(headers);
        
        // 设置正确的 Content-Type
        headers.set('Content-Type', mimeType);
        
        // 声明支持 Range 请求
        headers.set('Accept-Ranges', 'bytes');
        
        if (isPartialContent) {
            // 206 Partial Content 响应
            headers.set('Content-Length', (rangeEnd - rangeStart + 1).toString());
            headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
        } else {
            headers.set('Content-Length', totalSize.toString());
        }
        
        // 缓存控制
        headers.set('Cache-Control', 'no-store, max-age=0');
        
        // 设置文件名
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        
        // 直接传递 body
        return new Response(object.body, { 
            status: isPartialContent ? 206 : 200,
            headers 
        });
    } catch (error) {
        console.error('R2 fetch error:', error);
        const headers = new Headers();
        addCorsHeaders(headers);
        return new Response('Error fetching file from R2: ' + error.message, { status: 500, headers });
    }
}

// --- S3 文件处理 ---
async function handleS3File(context, fileId, record = null) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') return handleOptions();

    try {
        // 获取 KV 记录
        if (!record || !record.metadata) {
            if (env.img_url) {
                const prefixes = ['s3:', 'img:', 'vid:', 'aud:', 'doc:', ''];
                for (const prefix of prefixes) {
                    record = await env.img_url.getWithMetadata(`${prefix}${fileId}`);
                    if (record?.metadata) break;
                }
            }
        }
        if (!record?.metadata) {
            const headers = new Headers();
            addCorsHeaders(headers);
            return new Response('File not found', { status: 404, headers });
        }

        // 访问控制
        if (record.metadata.ListType === 'Block' || record.metadata.Label === 'adult') {
            const url = new URL(request.url);
            return Response.redirect(`${url.origin}/block-img.html`, 302);
        }

        const s3Key = record.metadata.s3Key || fileId.replace(/^s3:/, '');
        const fileName = record.metadata.fileName || fileId;
        const mimeType = getMimeType(fileName);
        const rangeHeader = request.headers.get('Range');

        const s3 = createS3Client(env);
        const s3Response = await s3.getObject(s3Key, rangeHeader ? { range: rangeHeader } : {});

        if (!s3Response) {
            return new Response('File not found in S3', { status: 404 });
        }

        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'no-store, max-age=0');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);

        // 透传 Content-Length 和 Content-Range
        const cl = s3Response.headers.get('Content-Length');
        if (cl) headers.set('Content-Length', cl);
        const cr = s3Response.headers.get('Content-Range');
        if (cr) headers.set('Content-Range', cr);

        return new Response(s3Response.body, {
            status: s3Response.status,
            headers
        });
    } catch (error) {
        console.error('S3 fetch error:', error);
        const headers = new Headers();
        addCorsHeaders(headers);
        return new Response('Error fetching file from S3: ' + error.message, { status: 500, headers });
    }
}

// --- Discord 文件处理 ---
async function handleDiscordFile(context, fileId, record = null) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') return handleOptions();

    try {
        // 获取 KV 记录
        if (!record || !record.metadata) {
            if (env.img_url) {
                const prefixes = ['discord:', 'img:', 'vid:', 'aud:', 'doc:', ''];
                for (const prefix of prefixes) {
                    record = await env.img_url.getWithMetadata(`${prefix}${fileId}`);
                    if (record?.metadata) break;
                }
            }
        }
        if (!record?.metadata) {
            const headers = new Headers();
            addCorsHeaders(headers);
            return new Response('File not found', { status: 404, headers });
        }

        // 访问控制
        if (record.metadata.ListType === 'Block' || record.metadata.Label === 'adult') {
            const url = new URL(request.url);
            return Response.redirect(`${url.origin}/block-img.html`, 302);
        }

        const { discordChannelId, discordMessageId } = record.metadata;
        if (!discordChannelId || !discordMessageId) {
            return new Response('Discord metadata incomplete', { status: 500 });
        }

        // 从 Discord API 获取最新的文件 URL
        const fileInfo = await getDiscordFileUrl(discordChannelId, discordMessageId, env);
        if (!fileInfo) {
            return new Response('File not found on Discord', { status: 404 });
        }

        // 代理文件内容（Discord CDN URL 会过期，不能直接重定向）
        const fileName = record.metadata.fileName || fileInfo.filename;
        const mimeType = getMimeType(fileName);

        const fetchHeaders = {};
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

        const discordResponse = await fetch(fileInfo.url, { headers: fetchHeaders });

        if (!discordResponse.ok && discordResponse.status !== 206) {
            return new Response('Error fetching file from Discord', { status: 502 });
        }

        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'no-store, max-age=0');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);

        const cl = discordResponse.headers.get('Content-Length');
        if (cl) headers.set('Content-Length', cl);
        const cr = discordResponse.headers.get('Content-Range');
        if (cr) headers.set('Content-Range', cr);

        return new Response(discordResponse.body, {
            status: discordResponse.status,
            headers
        });
    } catch (error) {
        console.error('Discord fetch error:', error);
        const headers = new Headers();
        addCorsHeaders(headers);
        return new Response('Error fetching file from Discord: ' + error.message, { status: 500, headers });
    }
}

// --- HuggingFace 文件处理 ---
async function handleHFFile(context, fileId, record = null) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') return handleOptions();

    try {
        // 获取 KV 记录
        if (!record || !record.metadata) {
            if (env.img_url) {
                const prefixes = ['hf:', 'img:', 'vid:', 'aud:', 'doc:', ''];
                for (const prefix of prefixes) {
                    record = await env.img_url.getWithMetadata(`${prefix}${fileId}`);
                    if (record?.metadata) break;
                }
            }
        }
        if (!record?.metadata) {
            const headers = new Headers();
            addCorsHeaders(headers);
            return new Response('File not found', { status: 404, headers });
        }

        // 访问控制
        if (record.metadata.ListType === 'Block' || record.metadata.Label === 'adult') {
            const url = new URL(request.url);
            return Response.redirect(`${url.origin}/block-img.html`, 302);
        }

        const hfPath = record.metadata.hfPath;
        if (!hfPath) {
            return new Response('HuggingFace path not found in metadata', { status: 500 });
        }

        const fileName = record.metadata.fileName || fileId;
        const mimeType = getMimeType(fileName);
        const rangeHeader = request.headers.get('Range');

        const hfResponse = await getHuggingFaceFile(hfPath, env, rangeHeader ? { range: rangeHeader } : {});

        if (!hfResponse.ok && hfResponse.status !== 206) {
            return new Response('File not found on HuggingFace', { status: 404 });
        }

        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Content-Type', mimeType);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'no-store, max-age=0');
        headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);

        const cl = hfResponse.headers.get('Content-Length');
        if (cl) headers.set('Content-Length', cl);
        const cr = hfResponse.headers.get('Content-Range');
        if (cr) headers.set('Content-Range', cr);

        return new Response(hfResponse.body, {
            status: hfResponse.status,
            headers
        });
    } catch (error) {
        console.error('HuggingFace fetch error:', error);
        const headers = new Headers();
        addCorsHeaders(headers);
        return new Response('Error fetching file from HuggingFace: ' + error.message, { status: 500, headers });
    }
}