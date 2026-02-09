import { createS3Client } from '../../../utils/s3client.js';
import { deleteDiscordMessage } from '../../../utils/discord.js';
import { deleteHuggingFaceFile } from '../../../utils/huggingface.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  let fileId = params.id;

  try {
    fileId = decodeURIComponent(fileId);
  } catch (error) {
    console.warn('Failed to decode fileId, using raw value:', fileId);
  }

  console.log('Deleting file:', fileId);

  try {
    if (!env.img_url) {
      throw new Error('KV binding img_url is not configured.');
    }

    const { record, kvKey } = await getRecordWithKey(env, fileId);
    if (!record || !record.metadata) {
      return jsonResponse(
        { success: false, error: 'File metadata not found.' },
        404
      );
    }

    const metadata = record.metadata;
    const storageType = metadata.storageType || metadata.storage || 'telegram';

    // --- R2 删除 ---
    const isR2 = fileId.startsWith('r2:') || storageType === 'r2';
    if (isR2) {
      const r2Key = metadata.r2Key
        || (kvKey?.startsWith('r2:') ? kvKey.slice(3) : null)
        || (fileId.startsWith('r2:') ? fileId.slice(3) : fileId);

      if (!env.R2_BUCKET) throw new Error('R2 bucket is not configured.');
      if (!r2Key) throw new Error('Failed to resolve R2 key.');

      await env.R2_BUCKET.delete(r2Key);
      await env.img_url.delete(kvKey);
      await purgeEdgeCache(request, fileId);

      return jsonResponse({
        success: true,
        message: 'Deleted from R2 and KV.',
        fileId, r2Key, kvKey
      });
    }

    // --- S3 删除 ---
    if (storageType === 's3' || fileId.startsWith('s3:')) {
      const s3Key = metadata.s3Key || fileId.replace(/^s3:/, '');
      try {
        const s3 = createS3Client(env);
        await s3.deleteObject(s3Key);
      } catch (e) {
        console.error('S3 delete error (best-effort):', e);
      }
      await env.img_url.delete(kvKey);
      await purgeEdgeCache(request, fileId);

      return jsonResponse({
        success: true,
        message: 'Deleted from S3 and KV.',
        fileId, kvKey
      });
    }

    // --- Discord 删除 ---
    if (storageType === 'discord' || fileId.startsWith('discord:')) {
      let discordDeleted = false;
      try {
        if (metadata.discordChannelId && metadata.discordMessageId) {
          discordDeleted = await deleteDiscordMessage(
            metadata.discordChannelId, metadata.discordMessageId, env
          );
        }
      } catch (e) {
        console.error('Discord delete error (best-effort):', e);
      }
      await env.img_url.delete(kvKey);
      await purgeEdgeCache(request, fileId);

      return jsonResponse({
        success: true,
        message: discordDeleted ? 'Deleted from Discord and KV.' : 'KV deleted (Discord best-effort).',
        fileId, kvKey
      });
    }

    // --- HuggingFace 删除 ---
    if (storageType === 'huggingface' || fileId.startsWith('hf:')) {
      let hfDeleted = false;
      try {
        if (metadata.hfPath) {
          hfDeleted = await deleteHuggingFaceFile(metadata.hfPath, env);
        }
      } catch (e) {
        console.error('HuggingFace delete error (best-effort):', e);
      }
      await env.img_url.delete(kvKey);
      await purgeEdgeCache(request, fileId);

      return jsonResponse({
        success: true,
        message: hfDeleted ? 'Deleted from HuggingFace and KV.' : 'KV deleted (HuggingFace best-effort).',
        fileId, kvKey
      });
    }

    // --- Telegram 删除（默认） ---
    let telegramDeleted = false;
    let telegramDeleteAttempted = false;
    let telegramDeleteError = null;

    try {
      if (metadata.telegramMessageId) {
        telegramDeleteAttempted = true;
        telegramDeleted = await deleteTelegramMessage(metadata.telegramMessageId, env);
      }
    } catch (error) {
      telegramDeleteError = error;
      console.error('Telegram deleteMessage threw:', error);
    } finally {
      await env.img_url.delete(kvKey);
      await purgeEdgeCache(request, fileId);
    }

    return jsonResponse({
      success: true,
      message: telegramDeleted
        ? 'Deleted from Telegram and KV.'
        : 'KV metadata deleted (Telegram deletion best-effort).',
      fileId, kvKey,
      telegramDeleteAttempted,
      telegramDeleted,
      warning: telegramDeleted ? '' : 'Telegram deletion failed or messageId missing.',
      telegramDeleteError: telegramDeleteError ? telegramDeleteError.message : null
    });
  } catch (error) {
    console.error('Delete error:', error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

async function getRecordWithKey(env, fileId) {
  const prefixes = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', ''];
  const hasKnownPrefix = prefixes.some((prefix) => prefix && fileId.startsWith(prefix));
  const candidateKeys = hasKnownPrefix ? [fileId] : prefixes.map((prefix) => `${prefix}${fileId}`);

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record && record.metadata) {
      return { record, kvKey: key };
    }
  }

  return { record: null, kvKey: fileId };
}

async function deleteTelegramMessage(messageId, env) {
  if (!messageId || !env.TG_Bot_Token || !env.TG_Chat_ID) {
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_Chat_ID,
        message_id: messageId
      })
    });

    let data = { ok: false };
    try {
      data = await response.json();
    } catch (jsonError) {
      console.error('Failed to parse Telegram deleteMessage response:', jsonError);
    }

    return response.ok && data.ok;
  } catch (error) {
    console.error('Telegram delete message error:', error);
    return false;
  }
}

async function purgeEdgeCache(request, fileId) {
  try {
    const cache = caches.default;
    const origin = new URL(request.url).origin;
    const urlsToPurge = [
      `${origin}/file/${fileId}`,
      `${origin}/file/${encodeURIComponent(fileId)}`,
    ];
    for (const url of urlsToPurge) {
      await cache.delete(new Request(url));
    }
  } catch (e) {
    console.warn('Edge cache purge failed (non-critical):', e.message);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
