/**
 * 认证管理器
 * 
 * 管理 DeepSeek 的 userToken 认证。
 * 
 * Token 来源：chat.deepseek.com 的 localStorage 中的 `userToken` 键
 * （JSON.parse 后的 .value 字段）
 * 
 * 自动登录流程：
 * 1. API 返回 401/403 → 触发 onLoginRequired
 * 2. 打开 Puppeteer 浏览器 → chat.deepseek.com
 * 3. 等待用户登录
 * 4. 从 localStorage 提取 userToken
 * 5. resolve Promise → 继续原请求
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const TOKEN_FILE = join(homedir(), '.deepseek-vision', 'config.json');

interface StoredToken {
  token: string;
  smidV2?: string;
  savedAt: number;
}

export class AuthManager {
  private token: string | null = null;
  private smidV2: string | null = null;
  private browser: Browser | null = null;
  /** 当前是否有登录浏览器窗口打开 */
  private loginInProgress = false;
  /** 等待登录的 Promise 解析器 */
  private loginResolver: ((token: string) => void) | null = null;

  constructor() {
    // 尝试从文件加载
    this.loadFromFile();
  }

  /** 获取当前 token */
  getToken(): string | null {
    return this.token;
  }

  /** 获取 smidV2 */
  getSmidV2(): string | null {
    return this.smidV2;
  }

  /** token 是否有效 */
  hasToken(): boolean {
    return !!this.token;
  }

  /**
   * 触发自动登录流程
   * 1. 打开浏览器
   * 2. 等待用户登录
   * 3. 从 localStorage 提取 userToken
   * 4. 保存到文件
   * 5. 返回 token
   */
  async login(): Promise<string> {
    // 如果已经在登录流程中，等待它完成
    if (this.loginInProgress && this.loginResolver) {
      console.error('[AuthManager] ⏳ 等待已有登录流程完成...');
      return new Promise((resolve) => {
        const handler = (token: string) => {
          this.loginResolver = null;
          resolve(token);
        };
        this.loginResolver = handler;
      });
    }

    this.loginInProgress = true;

    try {
      console.error('[AuthManager] 🌐 打开浏览器进行登录...');
      console.error('[AuthManager] 💡 请在打开的页面中登录 DeepSeek 账号');
      console.error('[AuthManager] 💡 登录后页面会自动检测并关闭');

      this.browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      }).catch(async (err) => {
        console.error('[AuthManager] ⚠️ 无法启动浏览器:', err.message);
        console.error('[AuthManager] 💡 请手动直接设置 DEEPSEEK_USER_TOKEN 环境变量');
        throw new Error(
          '无法自动打开浏览器。\n' +
          '请登录 chat.deepseek.com，按 F12 → Application → Local Storage → 找到 userToken，\n' +
          '复制其 JSON.parse 后的 value 值，然后设置环境变量:\n' +
          '  export DEEPSEEK_USER_TOKEN="你的token"'
        );
      });

      const page = await this.browser.newPage();
      await page.goto('https://chat.deepseek.com/', {
        waitUntil: 'load',
        timeout: 60000,
      }).catch(() => {
        console.error('[AuthManager] ⚠️ 页面加载警告（可忽略）');
      });

      console.error('[AuthManager] ⏳ 等待用户登录...');

      // 等待登录成功（从 localStorage 检测到 userToken）
      const token = await this.waitForToken(page);

      if (!token) {
        throw new Error('[AuthManager] 登录超时或失败');
      }

      // 同时捕获 smidV2 cookie
      const cookies = await page.cookies();
      const smidCookie = cookies.find(c => c.name === 'smidV2');
      if (smidCookie) {
        this.smidV2 = smidCookie.value;
      }

      this.token = token;
      this.saveToFile();

      console.error('[AuthManager] ✅ 登录成功，Token 已保存');

      // 关闭浏览器
      await this.browser.close().catch(() => {});
      this.browser = null;

      // 通知等待者
      this.loginResolver?.(token);
      this.loginResolver = null;

      return token;
    } catch (error) {
      this.loginResolver = null;
      throw error;
    } finally {
      this.loginInProgress = false;
    }
  }

  /**
   * 等待 localStorage 中出现 userToken
   * 轮询检查 localStorage.getItem('userToken')
   */
  private async waitForToken(page: Page, timeoutMs = 300000): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const token = await page.evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const value = parsed?.value || parsed;
            if (typeof value === 'string' && value.length > 20) {
              return value;
            }
            return null;
          } catch {
            return null;
          }
        });

        if (token) {
          // 等页面稳定
          await new Promise(r => setTimeout(r, 1500));
          return token;
        }
      } catch {
        // 页面可能正在导航
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    return null;
  }

  /** 从文件加载 token */
  private loadFromFile(): void {
    try {
      if (!existsSync(TOKEN_FILE)) return;
      const data = readFileSync(TOKEN_FILE, 'utf-8');
      const stored = JSON.parse(data) as StoredToken;
      if (stored.token) {
        this.token = stored.token;
        this.smidV2 = stored.smidV2 || null;
        console.error('[AuthManager] 📂 从文件加载 Token');
      }
    } catch {
      // ignore
    }
  }

  /** 保存 token 到文件 */
  private saveToFile(): void {
    if (!this.token) return;
    try {
      const stored: StoredToken = {
        token: this.token,
        smidV2: this.smidV2 || undefined,
        savedAt: Date.now(),
      };
      const dir = dirname(TOKEN_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2), 'utf-8');
      console.error(`[AuthManager] 💾 Token 已保存到 ${TOKEN_FILE}`);
    } catch (err) {
      console.error('[AuthManager] ⚠️ 保存 Token 失败:', err);
    }
  }

  /** 清理 */
  async destroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
