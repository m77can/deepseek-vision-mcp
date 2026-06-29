/**
 * DeepSeek 网页版 Vision API 客户端
 * 
 * 完整流水线：上传 → 等待处理 → Fork (to_model_type=vision) → 等待处理 → 创建会话 → PoW → Vision Completion
 */

import {
  type DeepSeekClientConfig,
  type FileInfo,
  type HifToken,
  type LoginCallback,
  type UploadFileResponse,
  type VisionCompletionRequest,
} from './types.js';

export class DeepSeekClient {
  private baseUrl: string;
  private token: string;
  private smidV2: string | undefined;
  private timeout: number;
  private abortController: AbortController | null = null;
  private loginCallback: LoginCallback | null = null;
  private _loggedEvent = false;

  constructor(config: DeepSeekClientConfig) {
    this.baseUrl = config.baseUrl || 'https://chat.deepseek.com';
    this.token = config.token;
    this.smidV2 = config.smidV2;
    this.timeout = config.timeout || 180_000;
  }

  setLoginCallback(cb: LoginCallback): void { this.loginCallback = cb; }
  setToken(token: string): void { this.token = token; console.error('[DSClient] ✅ Token 已更新'); }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/event-stream, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Origin': this.baseUrl,
      'Referer': `${this.baseUrl}/`,
      'X-App-Version': '2.0.0',
      'X-Client-Version': '1.0.0-always',
      'X-Client-Locale': 'zh-CN',
      'X-Client-Platform': 'web',
      ...extra,
    };
    if (this.smidV2) h['Cookie'] = `smidV2=${this.smidV2}`;
    return h;
  }

  private async fetch<T>(method: string, path: string, opts: {
    body?: unknown; formData?: FormData; headers?: Record<string, string>;
    allowRetry?: boolean;
  } = {}): Promise<T> {
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), this.timeout);
    try {
      const url = `${this.baseUrl}${path}`;
      const h = this.headers(opts.headers);
      const fo: RequestInit = { method, headers: h, signal: this.abortController.signal };
      if (opts.formData) { fo.body = opts.formData; delete (h as Record<string, string>)['Content-Type']; }
      else if (opts.body) { h['Content-Type'] = 'application/json'; fo.body = JSON.stringify(opts.body); }

      const resp = await fetch(url, fo);
      if ((resp.status === 401 || resp.status === 403) && opts.allowRetry !== false && this.loginCallback) {
        console.error(`[DSClient] 🔑 ${resp.status} 触发自动登录...`);
        this.token = await this.loginCallback.onLoginRequired();
        return this.fetch<T>(method, path, { ...opts, allowRetry: false });
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DS API ${resp.status}: ${text.slice(0, 300)}`);
      }
      const json = await resp.json() as Record<string, unknown>;
      // 检查应用层错误
      if (json && typeof json === 'object' && 'code' in json) {
        const code = (json as { code: number }).code;
        if (code && code !== 0 && code !== 200) {
          const msg = (json as { msg?: string }).msg || JSON.stringify(json).slice(0, 200);
          throw new Error(`DS API ${code}: ${msg}`);
        }
      }
      // 返回原始 JSON
      return json as T;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`超时 (${this.timeout}ms): ${path}`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ========== 步骤 1a: 创建并求解 PoW 挑战 ==========
  async createAndSolvePow(targetPath: string): Promise<string> {
    const res = await this.fetch<any>(
      'POST', '/api/v0/chat/create_pow_challenge',
      { body: { target_path: targetPath } },
    );
    let challengeData: string | undefined;
    if (typeof res === 'object') {
      challengeData = res.challenge || res.biz_data?.challenge;
      if (!challengeData && res.data?.biz_data?.challenge) {
        challengeData = typeof res.data.biz_data.challenge === 'string'
          ? res.data.biz_data.challenge
          : JSON.stringify(res.data.biz_data.challenge);
      }
    }
    if (!challengeData) {
      console.error('[DSClient] PoW 原始响应:', JSON.stringify(res).slice(0, 400));
      return '';
    }
    const { solvePowChallenge } = await import('./pow-solver.js');
    return await solvePowChallenge(challengeData);
  }

  // ========== 步骤 1: 上传图片（PoW 求解后上传） ==========
  async uploadImage(imageBase64: string): Promise<UploadFileResponse> {
    const bin = atob(imageBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = this.detectFormat(bytes);
    const blob = new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });
    const fd = new FormData();
    fd.append('file', blob, `img_${Date.now()}.${ext}`);

    // 获取 PoW 挑战
    console.error('[DSClient] 🔐 求解 PoW...');
    const powHeader = await this.createAndSolvePow('/api/v0/file/upload_file');

    const raw = await this.fetch<any>('POST', '/api/v0/file/upload_file', {
      formData: fd,
      headers: { 'x-ds-pow-response': powHeader },
    });
    // 解析嵌套响应: { data: { biz_data: { id: "file-xxx" } } }
    const bizData = raw?.data?.biz_data || raw;
    const fileId = bizData.id || bizData.file_id;
    if (!fileId) {
      console.error('[DSClient] 上传原始响应:', JSON.stringify(raw).slice(0, 300));
      throw new Error('上传失败：无 file_id');
    }
    return { ...bizData, id: fileId, file_id: fileId };
  }

  // ========== 步骤 2: 等待文件处理完成 ==========
  async waitForFile(fileId: string, maxWait = 60): Promise<FileInfo> {
    for (let i = 0; i < maxWait; i++) {
      const raw = await this.fetch<any>('GET', `/api/v0/file/fetch_files?file_ids=${fileId}`);
      const biz = raw?.data?.biz_data || raw;
      const file = biz?.files?.[0];
      if (file) {
        const s = (file.status || '').toUpperCase();
        if (s === 'SUCCESS') return file;
        if (s === 'FAILED' || s === 'ERROR') throw new Error(`文件处理失败: ${s}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('文件处理超时');
  }

  // ========== 步骤 3: Fork 到 Vision 模型 ==========
  async forkToVision(fileId: string): Promise<string> {
    const raw = await this.fetch<any>('POST', '/api/v0/file/fork_file_task', {
      body: { file_id: fileId, to_model_type: 'vision' },
    });
    const biz = raw?.data?.biz_data || raw;
    return biz.id;
  }

  // ========== 步骤 4: 创建会话 ==========
  async createSession(): Promise<string> {
    const raw = await this.fetch<any>('POST', '/api/v0/chat_session/create', {
      body: { agent: 'chat' },
    });
    const biz = raw?.data?.biz_data || raw;
    return biz.id;
  }

  // ========== 步骤 5: 创建 PoW 挑战 ==========
  async createPowChallenge(targetPath: string): Promise<string> {
    const res = await this.fetch<{ challenge?: string; biz_data?: { challenge?: string } }>(
      'POST', '/api/v0/chat/create_pow_challenge',
      { body: { target_path: targetPath } },
    );
    return res.challenge || res.biz_data?.challenge || '';
  }

  // ========== 步骤 6: 获取 HIF 签名 ==========
  async getHifTokens(): Promise<HifToken> {
    const [l, d] = await Promise.all([
      fetch('https://hif-leim.deepseek.com/query', { headers: this.headers() }),
      fetch('https://hif-dliq.deepseek.com/query', { headers: this.headers() }),
    ]);
    return { leim: l.ok ? (await l.text()).trim() : '', dliq: d.ok ? (await d.text()).trim() : '' };
  }

  // ========== 步骤 7: Vision Completion ==========
  async visionComplete(
    sessionId: string,
    visionFileId: string,
    prompt: string,
  ): Promise<string> {
    this._loggedEvent = false;

    const powHeader = await this.createAndSolvePow('/api/v0/chat/completion');

    // 使用 Node.js https 模块，通过 TLS ciphers 模拟 Chrome 指纹
    const https = await import('node:https');

    const body = JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: 'vision',
      prompt,
      ref_file_ids: [visionFileId],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    });

    const reqHeaders: Record<string, string> = {
      'accept': '*/*',
      'accept-language': 'zh_CN,zh_CN;q=0.9,en;q=0.8',
      'authorization': `Bearer ${this.token}`,
      'content-type': 'application/json',
      'priority': 'u=1, i',
      'origin': this.baseUrl,
      'referer': `${this.baseUrl}/a/chat/s/${sessionId}`,
      'x-app-version': '2.0.0',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '2.0.0',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (powHeader) reqHeaders['x-ds-pow-response'] = powHeader;
    if (this.smidV2) reqHeaders['cookie'] = `smidV2=${this.smidV2}`;

    console.error('[DSClient] 🤖 Vision 分析中（纯 JS）...');

    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        'https://chat.deepseek.com/api/v0/chat/completion',
        {
          method: 'POST',
          headers: reqHeaders,
          // Chrome 131 TLS ciphers
          ciphers: [
            'TLS_AES_128_GCM_SHA256',
            'TLS_AES_256_GCM_SHA384',
            'TLS_CHACHA20_POLY1305_SHA256',
          ].join(':'),
          honorCipherOrder: true,
        },
        (res) => {
          if (res.statusCode !== 200) {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => reject(new Error(`Vision HTTP ${res.statusCode}: ${data.slice(0, 300)}`)));
            return;
          }

          let raw = '';
          res.on('data', c => raw += c);
          res.on('end', () => {
            let result = '';
            for (const line of raw.split('\n')) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const p = t.slice(5).trim();
              if (p === '[DONE]') break;
              try {
                const ev = JSON.parse(p);
                if (ev.type === 'error') {
                  reject(new Error(ev.content || 'Vision 错误'));
                  return;
                }
                if (typeof ev.v === 'string') result += ev.v;
                if (ev.type === 'text') result += (ev.text || ev.content || '');
              } catch { /* skip */ }
            }
            resolve(result || '（无返回内容）');
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return result;
  }

  // ========== 完整流水线 ==========
  async recognizeImage(
    imageBase64: string,
    prompt: string = '请详细描述这张图片中的内容',
  ): Promise<string> {
    // 1. 上传
    console.error('[DSClient] 📤 上传图片...');
    const upload = await this.uploadImage(imageBase64);
    const uploadId = upload.file_id || upload.id!;
    console.error(`[DSClient] ✅ 上传成功: ${uploadId}`);

    // 2. 等待上传处理完成
    console.error('[DSClient] ⏳ 等待图片处理...');
    await this.waitForFile(uploadId);
    console.error('[DSClient] ✅ 图片处理完成');

    // 3. Fork 到 Vision
    console.error('[DSClient] 🔄 Fork 到 Vision 模型...');
    const visionId = await this.forkToVision(uploadId);
    console.error(`[DSClient] ✅ Fork 成功: ${visionId}`);

    // 4. 等待 Vision 处理
    console.error('[DSClient] ⏳ 等待 Vision 处理...');
    await this.waitForFile(visionId);
    console.error('[DSClient] ✅ Vision 处理完成');

    // 5. 创建会话
    console.error('[DSClient] 💬 创建会话...');
    const sessionId = await this.createSession();
    console.error(`[DSClient] ✅ 会话: ${sessionId}`);

    // 6. 获取 HIF 签名（非必需）
    try {
      await this.getHifTokens();
    } catch { /* ignore */ }

    // 7. Vision 完成
    console.error('[DSClient] 🤖 Vision 分析中...');
    const result = await this.visionComplete(sessionId, visionId, prompt);
    return result;
  }

  private detectFormat(bytes: Uint8Array): string {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    return 'png';
  }

  cancel(): void { this.abortController?.abort(); }
}
