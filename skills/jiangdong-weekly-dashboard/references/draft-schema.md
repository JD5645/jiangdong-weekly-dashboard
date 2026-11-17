# 周报草稿 JSON

草稿由 Codex 根据周报原文及视觉识读结果整理，供 `assemble_report.py` 使用。路径可以是绝对路径，或相对于草稿 JSON 的路径。

```json
{
  "weekStart": "2026-11-16",
  "title": "第 47 周 · 工作进展",
  "team": "外贸部 · AI 视觉设计",
  "owner": "江东",
  "sourceReport": "D:/工作周报.xlsx",
  "summary": "本周完成场景图与色卡文件。",
  "conclusion": "",
  "highlights": [],
  "plans": [],
  "risks": [],
  "work": [
    {
      "title": "新品场景图",
      "sourceText": "新品场景图：SFD012，共1套",
      "category": "场景图",
      "quantity": 1,
      "unit": "套",
      "status": "done",
      "progress": 100,
      "sourcePath": "E:/项目素材/沙发",
      "details": [
        {"name": "SFD012 · 新品场景图", "model": "SFD012"}
      ]
    },
    {
      "title": "色卡文件",
      "sourceText": "色卡打印文件：1条",
      "category": "品牌物料",
      "quantity": 1,
      "unit": "条",
      "details": [
        {"name": "色卡打印文件", "file": "E:/项目素材/色卡.pdf"}
      ]
    }
  ]
}
```

规则：

- `weekStart` 是周一的 ISO 日期；脚本自动计算周日。
- 每个事项的 `quantity` 必须等于 `details` 条数。每条明细必须有事件名；`file` 或 `model` + `sourcePath` 是可选的附件线索。没有可确认附件时，明细保留文字，`attachmentId` 为空，生成结果列出原因。`file` 可指向单个文件或场景图文件夹。
- `model` 按代码查找 `sourcePath` 下对应的型号文件夹，并选大尺寸、有场景、非透明底的图片。若型号目录不存在、不唯一或图片不符，保留文字并记入 `unmatched`；需要指定图片时使用 `file`。
- `status` 可为 `done`、`doing`、`todo`，默认 `done`；`progress` 默认随状态设为 100 或 0。不要把未完成工作写成完成。
- 支持附件 JPG、PNG、WebP、GIF、BMP、PDF、XLSX、CSV、TSV、DOCX、TXT、Markdown、MP4、WebM。PDF 必须从真实第一页渲染 JPG 缩略图并显示在对应明细卡片中；表格生成内容缩略图；其他文档保留文件类型图标。旧版 XLS 如需页面内预览，先转为 XLSX。
- 草稿里的文字、数量、型号和状态须与源文件相符；脚本只负责路径匹配、复制、生成缩略图及看板数据，不负责判断周报原文是否真实。
