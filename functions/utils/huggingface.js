/**
 * HuggingFace Datasets 存储工具模块
 * 使用 HF Hub API 上传/下载/删除文件
 */

/**
 * ArrayBuffer 转 Base64（Cloudflare Workers 兼容）
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 上传文件到 HuggingFace Dataset
 * @param {ArrayBuffer} fileBuffer - 文件内容
 * @param {string} pathInRepo - 在仓库中的路径，如 "uploads/abc.png"
 * @param {string} fileName - 原始文件名
 * @param {object} env - 环境变量 (HF_TOKEN, HF_REPO)
 * @returns {{ success, error }}
 */
export async function uploadToHuggingFace(fileBuffer, pathInRepo, fileName, env) {
    const HF_TOKEN = env.HF_TOKEN;
    const HF_REPO = env.HF_REPO;

    if (!HF_TOKEN || !HF_REPO) {
        return { success: false, error: 'HuggingFace 配置不完整' };
    }

    try {
        const base64Content = arrayBufferToBase64(fileBuffer);

        // 构建 NDJSON body
        const headerLine = JSON.stringify({
            key: 'header',
            value: { summary: `Upload ${fileName}` }
        });

        const fileLine = JSON.stringify({
            key: 'file',
            value: {
                content: base64Content,
                path: pathInRepo,
                encoding: 'base64'
            }
        });

        const body = headerLine + '\n' + fileLine;

        const response = await fetch(
            `https://huggingface.co/api/datasets/${HF_REPO}/commit/main`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${HF_TOKEN}`,
                    'Content-Type': 'application/x-ndjson'
                },
                body: body
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HF 上传失败 (${response.status}): ${errorText}` };
        }

        const result = await response.json();
        return { success: true, commitOid: result.commitOid };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 从 HuggingFace Dataset 获取文件
 * 返回一个可以直接代理给客户端的 Response
 * @param {string} pathInRepo - 文件在仓库中的路径
 * @param {object} env - 环境变量
 * @param {object} options - 可选参数 { range }
 */
export async function getHuggingFaceFile(pathInRepo, env, options = {}) {
    const HF_REPO = env.HF_REPO;
    const url = `https://huggingface.co/datasets/${HF_REPO}/resolve/main/${pathInRepo}`;

    const headers = {};
    // 私有仓库需要 Token
    if (env.HF_TOKEN) {
        headers['Authorization'] = `Bearer ${env.HF_TOKEN}`;
    }
    if (options.range) {
        headers['Range'] = options.range;
    }

    const response = await fetch(url, {
        headers,
        redirect: 'follow'
    });

    return response;
}

/**
 * 获取文件的公开下载 URL
 */
export function getHuggingFacePublicUrl(pathInRepo, env) {
    return `https://huggingface.co/datasets/${env.HF_REPO}/resolve/main/${pathInRepo}`;
}

/**
 * 从 HuggingFace Dataset 删除文件
 */
export async function deleteHuggingFaceFile(pathInRepo, env) {
    const HF_TOKEN = env.HF_TOKEN;
    const HF_REPO = env.HF_REPO;

    if (!HF_TOKEN || !HF_REPO) {
        return false;
    }

    try {
        const headerLine = JSON.stringify({
            key: 'header',
            value: { summary: `Delete ${pathInRepo}` }
        });

        const deleteLine = JSON.stringify({
            key: 'deletedFile',
            value: { path: pathInRepo }
        });

        const body = headerLine + '\n' + deleteLine;

        const response = await fetch(
            `https://huggingface.co/api/datasets/${HF_REPO}/commit/main`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${HF_TOKEN}`,
                    'Content-Type': 'application/x-ndjson'
                },
                body: body
            }
        );

        return response.ok;
    } catch (error) {
        console.error('HF delete error:', error);
        return false;
    }
}

/**
 * 检查 HuggingFace 连接状态
 */
export async function checkHuggingFaceConnection(env) {
    if (!env.HF_TOKEN || !env.HF_REPO) {
        return { connected: false };
    }

    try {
        const response = await fetch(
            `https://huggingface.co/api/datasets/${env.HF_REPO}`,
            { headers: { 'Authorization': `Bearer ${env.HF_TOKEN}` } }
        );

        if (response.ok) {
            const data = await response.json();
            return {
                connected: true,
                repoId: data.id,
                isPrivate: data.private
            };
        }
        return { connected: false };
    } catch (e) {
        return { connected: false };
    }
}
