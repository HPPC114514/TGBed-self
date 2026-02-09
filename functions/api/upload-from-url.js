/**
 * URL代理上传API
 * 解决前端直接fetch外部URL时的CORS限制问题
 *
 * POST /api/upload-from-url
 * Body: { url: string, storageMode?: string }
 */
import { errorHandling, telemetryData } from "../../utils/middleware";
import { checkAuthentication, isAuthRequired } from "../../utils/auth.js";
import { checkGuestUpload, incrementGuestCount } from "../../utils/guest.js";
import { createS3Client } from "../../utils/s3client.js";
import { uploadToDiscord } from "../../utils/discord.js";
import { uploadToHuggingFace } from "../../utils/huggingface.js";

// 允许的最大文件大小（20MB，与Telegram限制一致）
const MAX_FILE_SIZE = 20 * 1024 * 1024;
// 请求超时时间（30秒）
const FETCH_TIMEOUT = 30000;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await errorHandling(context);
    telemetryData(context);

    // 解析请求体
    const body = await request.json();
    const { url, storageMode = "telegram" } = body;

    // 验证URL
    if (!url || typeof url !== "string") {
      return errorResponse("请提供有效的URL", 400);
    }

    // URL格式验证
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return errorResponse("仅支持HTTP/HTTPS协议的URL", 400);
      }
    } catch {
      return errorResponse("URL格式无效", 400);
    }

    // 权限检查
    const isAdmin = await isUserAuthenticated(context);

    // 从URL获取文件
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // 模拟浏览器请求，避免被某些服务器拒绝
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "image/*,video/*,audio/*,*/*",
        },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        return errorResponse("请求超时，目标服务器响应过慢", 408);
      }
      return errorResponse("无法连接到目标URL: " + error.message, 502);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return errorResponse(
        `目标URL返回错误: ${response.status} ${response.statusText}`,
        502,
      );
    }

    // 检查内容类型
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    // 获取文件内容
    const arrayBuffer = await response.arrayBuffer();
    const fileSize = arrayBuffer.byteLength;

    // 检查文件大小
    if (fileSize === 0) {
      return errorResponse("目标URL返回的内容为空", 400);
    }

    if (fileSize > MAX_FILE_SIZE) {
      return errorResponse(
        `文件大小(${formatSize(fileSize)})超过限制(${formatSize(MAX_FILE_SIZE)})`,
        413,
      );
    }

    // 访客权限检查
    if (!isAdmin) {
      const guestCheck = await checkGuestUpload(request, env, fileSize);
      if (!guestCheck.allowed) {
        return new Response(JSON.stringify({ error: guestCheck.reason }), {
          status: guestCheck.status || 403,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 从URL路径提取文件名，如果没有则根据内容类型生成
    let fileName = parsedUrl.pathname.split("/").pop() || "";
    fileName = fileName.split("?")[0]; // 移除查询参数

    if (!fileName || fileName === "") {
      // 根据内容类型生成文件名
      const ext = getExtensionFromMimeType(contentType);
      fileName = `url_${Date.now()}.${ext}`;
    }

    // 确保文件名有扩展名
    if (!fileName.includes(".")) {
      const ext = getExtensionFromMimeType(contentType);
      fileName = `${fileName}.${ext}`;
    }

    const fileExtension = fileName.split(".").pop().toLowerCase();

    // 创建File对象
    const file = new File([arrayBuffer], fileName, { type: contentType });

    // 根据存储模式上传
    let result;
    if (storageMode === "r2") {
      if (!env.R2_BUCKET) {
        return errorResponse("R2 未配置或未启用，无法上传");
      }
      result = await uploadToR2(file, fileName, fileExtension, env);
    } else if (storageMode === "s3") {
      if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID) {
        return errorResponse("S3 未配置，无法上传");
      }
      result = await uploadToS3(file, fileName, fileExtension, env);
    } else if (storageMode === "discord") {
      if (!env.DISCORD_WEBHOOK_URL && !env.DISCORD_BOT_TOKEN) {
        return errorResponse("Discord 未配置，无法上传");
      }
      result = await uploadToDiscordStorage(file, fileName, fileExtension, env);
    } else if (storageMode === "huggingface") {
      if (!env.HF_TOKEN || !env.HF_REPO) {
        return errorResponse("HuggingFace 未配置，无法上传");
      }
      result = await uploadToHFStorage(file, fileName, fileExtension, env);
    } else {
      // 默认上传到 Telegram
      result = await uploadToTelegramStorage(
        file,
        fileName,
        fileExtension,
        env,
      );
    }

    // 访客计数（仅成功时）
    if (
      !isAdmin &&
      result instanceof Response &&
      result.status >= 200 &&
      result.status < 300
    ) {
      await incrementGuestCount(request, env);
    }

    return result;
  } catch (error) {
    console.error("URL upload error:", error);
    return errorResponse("服务器内部错误: " + error.message);
  }
}

// 检查用户是否已认证
async function isUserAuthenticated(context) {
  const { env } = context;
  if (!isAuthRequired(env)) return true;
  try {
    const auth = await checkAuthentication(context);
    return auth.authenticated;
  } catch {
    return false;
  }
}

function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// 根据MIME类型获取文件扩展名
function getExtensionFromMimeType(mimeType) {
  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
  };
  return mimeMap[mimeType] || "bin";
}

// --- Telegram 上传 ---
async function uploadToTelegramStorage(
  uploadFile,
  fileName,
  fileExtension,
  env,
) {
  const telegramFormData = new FormData();
  telegramFormData.append("chat_id", env.TG_Chat_ID);

  let apiEndpoint;
  if (uploadFile.type.startsWith("image/")) {
    telegramFormData.append("photo", uploadFile);
    apiEndpoint = "sendPhoto";
  } else if (uploadFile.type.startsWith("audio/")) {
    telegramFormData.append("audio", uploadFile);
    apiEndpoint = "sendAudio";
  } else if (uploadFile.type.startsWith("video/")) {
    telegramFormData.append("video", uploadFile);
    apiEndpoint = "sendVideo";
  } else {
    telegramFormData.append("document", uploadFile);
    apiEndpoint = "sendDocument";
  }

  const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

  if (!result.success) {
    throw new Error(result.error);
  }

  const fileId = getFileId(result.data);
  const messageId = result.messageId || result.data?.result?.message_id;

  if (!fileId) {
    throw new Error("Failed to get file ID");
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
        storageType: "telegram",
        telegramMessageId: messageId || undefined,
      },
    });
  }

  return new Response(
    JSON.stringify([{ src: `/file/${fileId}.${fileExtension}` }]),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function getFileId(response) {
  if (!response.ok || !response.result) return null;

  const result = response.result;
  if (result.photo) {
    return result.photo.reduce((prev, current) =>
      prev.file_size > current.file_size ? prev : current,
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseData = await response.json();

    if (response.ok) {
      return {
        success: true,
        data: responseData,
        messageId: responseData?.result?.message_id,
      };
    }

    if (response.status === 429) {
      const retryAfter = responseData.parameters?.retry_after || 5;
      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
      }
      return { success: false, error: `速率限制，请 ${retryAfter} 秒后重试` };
    }

    if (response.status === 413) {
      return { success: false, error: "Telegram 限制：文件大小不能超过 20MB" };
    }

    if (
      retryCount < MAX_RETRIES &&
      (apiEndpoint === "sendPhoto" || apiEndpoint === "sendAudio")
    ) {
      const newFormData = new FormData();
      newFormData.append("chat_id", formData.get("chat_id"));
      const fileField = apiEndpoint === "sendPhoto" ? "photo" : "audio";
      newFormData.append("document", formData.get(fileField));
      return await sendToTelegram(
        newFormData,
        "sendDocument",
        env,
        retryCount + 1,
      );
    }

    return {
      success: false,
      error: responseData.description || "Upload to Telegram failed",
    };
  } catch (error) {
    if (error.name === "AbortError") {
      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * (retryCount + 1)),
        );
        return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
      }
      return { success: false, error: "上传超时，请重试" };
    }

    if (retryCount < MAX_RETRIES) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, retryCount)),
      );
      return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
    }
    return { success: false, error: "网络错误，请检查网络连接后重试" };
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
      customMetadata: { fileName: fileName, uploadTime: Date.now().toString() },
    });

    if (env.img_url) {
      await env.img_url.put(`r2:${objectKey}`, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName: fileName,
          fileSize: file.size,
          storageType: "r2",
          r2Key: objectKey,
        },
      });
    }

    return new Response(JSON.stringify([{ src: `/file/r2:${objectKey}` }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("R2 upload error:", error);
    return errorResponse("R2 上传失败: " + error.message);
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
      contentType: file.type || "application/octet-stream",
      metadata: {
        "x-amz-meta-filename": fileName,
        "x-amz-meta-uploadtime": Date.now().toString(),
      },
    });

    if (env.img_url) {
      await env.img_url.put(`s3:${objectKey}`, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName: fileName,
          fileSize: file.size,
          storageType: "s3",
          s3Key: objectKey,
        },
      });
    }

    return new Response(JSON.stringify([{ src: `/file/s3:${objectKey}` }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("S3 upload error:", error);
    return errorResponse("S3 上传失败: " + error.message);
  }
}

// --- Discord 上传 ---
async function uploadToDiscordStorage(file, fileName, fileExtension, env) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await uploadToDiscord(arrayBuffer, fileName, file.type, env);

    if (!result.success) {
      return errorResponse("Discord 上传失败: " + result.error);
    }

    const fileId = `discord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const kvKey = `discord:${fileId}.${fileExtension}`;

    if (env.img_url) {
      await env.img_url.put(kvKey, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName: fileName,
          fileSize: file.size,
          storageType: "discord",
          discordChannelId: result.channelId,
          discordMessageId: result.messageId,
          discordAttachmentId: result.attachmentId,
        },
      });
    }

    return new Response(JSON.stringify([{ src: `/file/${kvKey}` }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Discord upload error:", error);
    return errorResponse("Discord 上传失败: " + error.message);
  }
}

// --- HuggingFace 上传 ---
async function uploadToHFStorage(file, fileName, fileExtension, env) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const fileId = `hf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const hfPath = `uploads/${fileId}.${fileExtension}`;

    const result = await uploadToHuggingFace(
      arrayBuffer,
      hfPath,
      fileName,
      env,
    );

    if (!result.success) {
      return errorResponse("HuggingFace 上传失败: " + result.error);
    }

    const kvKey = `hf:${fileId}.${fileExtension}`;

    if (env.img_url) {
      await env.img_url.put(kvKey, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName: fileName,
          fileSize: file.size,
          storageType: "huggingface",
          hfPath: hfPath,
        },
      });
    }

    return new Response(JSON.stringify([{ src: `/file/${kvKey}` }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("HuggingFace upload error:", error);
    return errorResponse("HuggingFace 上传失败: " + error.message);
  }
}
