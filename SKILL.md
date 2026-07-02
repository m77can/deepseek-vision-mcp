# DeepSeek Vision 识图

当用户需要分析图片内容时，使用 MCP 工具 `deepseek-vision` / `recognize_image`。

## 触发条件
- 用户上传/粘贴图片附件
- 用户说"看这张图"、"图片是什么"、"分析截图"
- 对话里已显示图片

## ⚠️ 最常见错误（第一步就失败）

Agent 上下文里的图片引用**不能**直接传给 `recognize_image`：

```
❌ recognize_image({ image: "local://image-d5fa23d893da02fe.png" })
❌ recognize_image({ image: ".reasonix/attachments/clipboard-20260702-101646.786399-000001.png" })
```

这些都会报错「无法读取图片文件」。**必须先 shell 一步，再识图一步。**

## 正确流程（固定两步，不可跳过）

### 步骤 1：shell 执行 `ls -al`，解析绝对路径

对上下文里出现的图片引用原样执行：

```bash
ls -al local://image-d5fa23d893da02fe.png
# 或
ls -al .reasonix/attachments/clipboard-20260702-101646.786399-000001.png
```

从 `ls -al` 输出取**以 `/` 开头的绝对路径**，例如：
```
/Users/wangsong/.omp/agent/sessions/.../local/image-d5fa23d893da02fe.png
```

### 步骤 2：用绝对路径调用识图

```
✅ recognize_image({
  image: "/Users/wangsong/.omp/agent/sessions/.../local/image-d5fa23d893da02fe.png",
  prompt: "描述这张图片"
})
```

**规则：`image` 必须以 `/` 开头（绝对路径），或是 `data:image/...;base64,...`。其他形式一律先 `ls -al`。**

## 兜底

| 情况 | 做法 |
|------|------|
| 上下文已是 `/` 开头的绝对路径 | 直接传 |
| 有 `local://` 或 `.reasonix/...` 等引用 | **先 `ls -al`，再传解析出的绝对路径** |
| `ls` 失败但能读图内容 | `cp` 或写入 `/tmp/vision-<ts>.png`，传 `/tmp/...` |
| 有 data URI | 可直接传 `data:image/...;base64,...` |
| 都不行 | 问用户 |

## 注意事项
- **禁止**把 `local://`、`./`、`../`、`.reasonix/` 等引用直接当 `image` 传入
- 首次使用自动弹出浏览器登录 DeepSeek
- Token 自动保存，过期自动刷新
- 不要尝试让模型直接"看"图片，必须通过此工具
