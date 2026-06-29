# DeepSeek Vision 识图

当用户需要分析图片内容时，使用 MCP 工具 `deepseek-vision` / `recognize_image`。

## 触发条件
- 用户上传/粘贴图片附件
- 用户说"看这张图"、"图片是什么"、"分析截图"
- 任何 .png/.jpg/.gif/.webp/.bmp 文件路径

## 调用方式
```
mcp__deepseek-vision__recognize_image({
  image: "/path/to/image.png",
  prompt: "描述这张图片"
})
```

## 注意事项
- 首次使用自动弹出浏览器登录 DeepSeek
- Token 自动保存，过期自动刷新
- 不要尝试让模型直接"看"图片，必须通过此工具
# test update
