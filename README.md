# DeepSeek Vision MCP Server

将 DeepSeek 网页版识图（Vision）模式封装为 MCP 工具，解决 DeepSeek 模型无法直接处理图像的问题。

## 安装

```bash
git clone <repo> && cd deepseek-vision-mcp
npm install && npm run build
```

## 使用

### 方式一：自动登录（推荐，桌面环境）

无需任何配置，直接启动：

```bash
npm start
```

首次启动时自动打开浏览器让您登录 DeepSeek，Token 自动保存到 `~/.deepseek-vision/config.json`，后续自动复用。

Token 过期后会自动弹出浏览器重新登录。

### 方式二：手动配置（服务器环境）

在 `.mcp.json` 中设置环境变量：

```json
{
  "mcpServers": {
    "deepseek-vision": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "DEEPSEEK_USER_TOKEN": "你的token",
        "DEEPSEEK_SMIDV2": "你的smidV2（可选）"
      }
    }
  }
}
```

Token 获取方法：`https://chat.deepseek.com` → F12 → Application → Local Storage → `userToken` → `JSON.parse(value).value`

## MCP 工具

### `recognize_image`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image` | string | ✅ | 绝对路径或 data URI。DeepSeek 模型识图必须走本工具；先 `ls -al` 解析路径，详见 SKILL.md |
| `prompt` | string | ❌ | 提问（默认：请详细描述这张图片中的内容） |

**模型规则：** 当前对话使用 DeepSeek 模型（`deepseek-chat`、`deepseek-reasoner` 等）时，分析图片内容必须优先调用 `recognize_image`，不要让 DeepSeek 直接"看"图。

```
recognize_image({ image: "/tmp/screenshot.png", prompt: "这张图是什么" })
```

## 项目结构

```
src/
├── index.ts           # MCP Server 入口 + Skill 自动安装
├── deepseek-client.ts # API 客户端（上传/Fork/PoW/Completion）
├── auth-manager.ts    # Puppeteer 自动登录 + Token 管理
├── pow-solver.ts      # WASM PoW 求解器
├── types.ts           # 类型定义
└── wasm/              # PoW 模块
SKILL.md               # Agent Skill 定义
```

启动时自动将 `SKILL.md` 安装到 `~/.agents/skills/deepseek-vision/SKILL.md`。
