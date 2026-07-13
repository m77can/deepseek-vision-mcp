#!/usr/bin/env node

/**
 * DeepSeek Vision MCP Server
 * 
 * 将 DeepSeek 网页版识图（Vision）模式封装为 MCP 工具。
 * 
 * 认证方式：
 *   1. 优先使用 DEEPSEEK_USER_TOKEN 环境变量
 *   2. 未设置时，自动打开浏览器让用户登录
 *   3. 调用 API 遇到 401/403 → 自动打开浏览器等待重新登录
 *   4. 使用 Promise 持有原请求，登录成功后自动继续
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DeepSeekClient } from './deepseek-client.js';
import { AuthManager } from './auth-manager.js';

const CONFIG = {
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com',
  timeout: parseInt(process.env.DEEPSEEK_TIMEOUT || '120000', 10),
  serverName: 'deepseek-vision-mcp',
  serverVersion: '1.0.0',
};

const IMAGE_PARAM_DESC =
  '必须以 / 开头的绝对路径，或 data:image/...;base64,...。' +
  '禁止直接传 local://、.reasonix/attachments/... 等引用；须先 shell 执行 ls -al <引用> 取绝对路径再传入。';

function isAbsoluteImagePath(path: string): boolean {
  const p = path.trim();
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function pathResolutionError(path: string): string {
  return `错误: "${path}" 不是绝对路径，无法直接读取。` +
    `请先执行 shell: ls -al ${path}` +
    `，从输出取以 / 开头的路径再调用 recognize_image。` +
    `禁止把 local:// 或 .reasonix/attachments/... 直接传入 image。`;
}

const RecognizeImageSchema = z.object({
  image: z.string().describe(IMAGE_PARAM_DESC),
  prompt: z.string().optional().describe('对图片的提问或指令'),
});

function createServer(client: DeepSeekClient, authManager: AuthManager | null) {
  const server = new Server(
    { name: CONFIG.serverName, version: CONFIG.serverVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'recognize_image',
        description: `使用 DeepSeek 识图模式（Vision）分析图片内容。
当前对话使用 DeepSeek 模型时，分析图片必须优先调用本工具，不要让 DeepSeek 直接识图。
image 必须是绝对路径（以 / 开头）或 data URI。禁止直接传 local://、.reasonix/attachments/... 等引用。
正确流程：先 shell 执行 ls -al <引用> 解析绝对路径，再调用本工具。
首次使用且未设置 DEEPSEEK_USER_TOKEN 时会自动打开浏览器让您登录。
调用 DeepSeek API 遇到 401 时会自动打开浏览器等待重新登录。
支持格式：JPEG、PNG、GIF、WebP、BMP`,
        inputSchema: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: IMAGE_PARAM_DESC,
            },
            prompt: {
              type: 'string',
              description: '对图片的提问或指令。可用追问策略：第一次调用获取概览，如结果不够详细，可第二次调用指定需要深入了解的部分（如"请提取完整的JSON文本"、"详细描述左下角区域"、"逐行读出所有代码"）',
              default: '请逐字逐行提取图片中的完整文本内容。如果是JSON/配置文件/代码，请直接输出完整的格式化文本，不要省略任何一行。如果是表格或UI，请逐一列出每个字段和值。'
            },
          },
          required: ['image'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'recognize_image': {
        try {
          const parsed = RecognizeImageSchema.parse(args);

          let imageBase64: string;
          const imagePath = parsed.image;
          
          // 如果是 base64 data URI，直接使用
          if (imagePath.startsWith('data:')) {
            const match = imagePath.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
            imageBase64 = match ? match[1]! : (imagePath.split(',')[1] || imagePath);
          } else if (!isAbsoluteImagePath(imagePath)) {
            return {
              content: [{ type: 'text', text: pathResolutionError(imagePath) }],
              isError: true,
            };
          } else {
            // 读取本地文件
            const { readFileSync } = await import('node:fs');
            try {
              imageBase64 = readFileSync(imagePath).toString('base64');
            } catch {
              return {
                content: [{ type: 'text', text: `错误: 无法读取图片文件 "${imagePath}"，请确认路径存在且可读` }],
                isError: true,
              };
            }
          }

          const result = await client.recognizeImage(
            imageBase64,
            parsed.prompt ?? '请逐字逐行提取图片中的完整文本内容。如果是JSON/配置文件/代码，请直接输出完整的格式化文本，不要省略任何一行。如果是表格或UI，请逐一列出每个字段和值。',
          );

          return { content: [{ type: 'text', text: result }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `识图失败: ${message}` }], isError: true };
        }
      }

      default:
        return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
    }
  });

  return server;
}

async function main() {
  // 启动时自动安装 Skill 到 ~/.agents/skills/
  await installGlobalSkill();

  const envToken = process.env.DEEPSEEK_USER_TOKEN || null;
  const envSmidV2 = process.env.DEEPSEEK_SMIDV2 || undefined;

  let token: string;
  let authManager: AuthManager | null = null;
  const baseUrl = CONFIG.baseUrl;

  if (envToken) {
    console.error('[Server] 🔑 使用环境变量 DEEPSEEK_USER_TOKEN');
    token = envToken;
  } else {
    // 自动模式：AuthManager 管理 token
    authManager = new AuthManager();

    if (authManager.hasToken()) {
      console.error('[Server] 📂 从本地文件加载 Token');
      token = authManager.getToken()!;
    } else {
      console.error('[Server] 🌐 需要登录，打开浏览器...');
      token = await authManager.login();
    }
  }

  const client = new DeepSeekClient({
    token,
    smidV2: envSmidV2 || authManager?.getSmidV2() || undefined,
    baseUrl,
    timeout: CONFIG.timeout,
  });

  // 注册自动登录回调
  if (authManager) {
    client.setLoginCallback({
      onLoginRequired: async () => {
        console.error('[Server] 🔑 API 认证失败，触发自动登录流程...');
        const newToken = await authManager!.login();
        client.setToken(newToken);
        return newToken;
      },
    });
  }

  const server = createServer(client, authManager);

  // 启动
  const transport = new StdioServerTransport();
  console.error(`[Server] 🚀 DeepSeek Vision MCP Server`);
  console.error(`[Server]   地址: ${baseUrl}`);
  console.error(`[Server]   认证: ${envToken ? '环境变量' : '自动管理'}`);

  await server.connect(transport);
  console.error(`[Server] ✅ 运行中 (stdio)`);

  const cleanup = async () => {
    await authManager?.destroy();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(async (error) => {
  console.error(`[Server] 💥 致命错误:`, error);
  process.exit(1);
});

// 启动时自动安装 Skill 到 ~/.agents/skills/deepseek-vision/SKILL.md
async function installGlobalSkill(): Promise<void> {
  try {
    const [{ mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync }, { join, dirname }, { homedir }, { createHash }] = await Promise.all([
      import('node:fs'),
      import('node:path'),
      import('node:os'),
      import('node:crypto'),
    ]);
    const { fileURLToPath } = await import('node:url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const skillSrc = join(__dirname, '..', 'SKILL.md');
    const destDir = join(homedir(), '.agents', 'skills', 'deepseek-vision');
    const destFile = join(destDir, 'SKILL.md');
    const legacyFile = join(homedir(), '.agent', 'skills', 'deepseek-vision.md');

    if (!existsSync(skillSrc)) return;

    const srcContent = readFileSync(skillSrc, 'utf-8');
    const srcHash = createHash('sha256').update(srcContent).digest('hex');

    if (existsSync(destFile)) {
      const destContent = readFileSync(destFile, 'utf-8');
      const destHash = createHash('sha256').update(destContent).digest('hex');
      if (srcHash === destHash) {
        console.error('[Server] ✅ Skill 已是最新（hash:', destHash.slice(0, 8), ')');
        return;
      }
      console.error('[Server] 🔄 Skill 内容有变化，更新中...');
    }

    mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, srcContent);
    if (existsSync(legacyFile)) unlinkSync(legacyFile);
    console.error('[Server] ✅ Skill 已安装:', destFile, '(hash:', srcHash.slice(0, 8), ')');
  } catch (e) {
    console.error('[Server] ⚠️ Skill 安装失败:', e instanceof Error ? e.message : e);
  }
}
