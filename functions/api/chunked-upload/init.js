/**
 * 分片上传 API
 * 支持大文件分片上传和断点续传
 */
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { checkGuestUpload } from '../../utils/guest.js';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB 每个分片
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 最大支持 100MB

/**
 * 初始化分片上传
 * POST /api/chunked-upload/init
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 检查认证（管理员或访客）
    const isAdmin = isAuthRequired(env)
      ? (await checkAuthentication(context)).authenticated
      : true;

    if (!isAdmin) {
      // 非管理员：检查访客权限（分片上传对访客禁用）
      const guestCheck = await checkGuestUpload(request, env, 0);
      if (!guestCheck.allowed) {
        return new Response(JSON.stringify({ error: '访客不支持分片上传，请使用普通上传' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    const body = await request.json();
    const { fileName, fileSize, fileType, totalChunks, storageMode } = body;

    // 验证参数
    if (!fileName || !fileSize || !totalChunks) {
      return new Response(JSON.stringify({ error: '缺少必要参数' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (fileSize > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: `文件大小超过限制 (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成上传 ID
    const uploadId = generateUploadId();

    // 规范化存储模式
    const validModes = ['telegram', 'r2', 's3', 'discord', 'huggingface'];
    const normalizedStorage = validModes.includes(storageMode) ? storageMode : 'telegram';

    const uploadTask = {
      uploadId,
      fileName,
      fileSize,
      fileType,
      totalChunks,
      storageMode: normalizedStorage,
      uploadedChunks: [],
      createdAt: Date.now(),
      status: 'pending'
    };

    await env.img_url.put(`upload:${uploadId}`, JSON.stringify(uploadTask), {
      expirationTtl: 3600 // 1小时过期
    });

    return new Response(JSON.stringify({
      success: true,
      uploadId,
      chunkSize: CHUNK_SIZE
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Init upload error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 查询上传状态（用于断点续传）
 * GET /api/chunked-upload/init?uploadId=xxx
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');

  if (!uploadId) {
    return new Response(JSON.stringify({ error: '缺少 uploadId' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    
    if (!taskData) {
      return new Response(JSON.stringify({ error: '上传任务不存在或已过期' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    return new Response(JSON.stringify({
      success: true,
      ...taskData
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

function generateUploadId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}
