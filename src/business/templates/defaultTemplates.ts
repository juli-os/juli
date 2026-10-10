// 默认模板（对应 Go 的 go:embed email-reply.yaml / video-prod.yaml）。以 TS
// 字符串常量内嵌：dev/test/build 三态零路径问题，首次运行 seed 到磁盘目录。
// 文件是作者层的事实源；磁盘同名文件覆盖这里的内嵌版本。

export const EMAIL_REPLY_YAML = `key: email-reply
name: 邮件回信业务流
trigger: email
zombie:
  timeout: 5m
  max_attempts: 3
steps:
  - id: extract
    kind: triage
    title: 抽取：邮件结构化
  - id: plan_gate
    kind: gate
    title: 闸门：抽取审批
  - id: execute
    kind: agent
    title: 抽取执行
  - id: verify
    kind: verify
    title: 转换与集成
  - id: review_gate
    kind: gate
    title: 闸门：成品审批
  - id: draft
    kind: draft
    title: 起草回信
  - id: reply_gate
    kind: gate
    title: 闸门：回信审批
  - id: send
    kind: send
    title: SMTP 发送回信
`;

export const VIDEO_PROD_YAML = `key: video-prod
name: 视频制作流水
trigger: manual
zombie:
  timeout: 15m
  max_attempts: 2
steps:
  - id: concept
    kind: llm
    title: 创意定稿
    prompt: |
      你是视频创意监制。基于下面的 concept，finalize 一份创意简报，输出 JSON：
      {"title":"视频标题","logline":"一句话概述","audience":"目标观众","style":"视觉风格与节奏","takeaways":["观众看完记住的三件事"]}
      要求：具体、可执行、不空泛；时长按 60~90 秒短视频设计。

      Concept:
      {{.Input.concept}}
    system: 你是专业的视频创意策划。只输出 JSON。

  - id: concept_gate
    kind: gate
    title: 闸门①：创意拍板

  - id: storyboard
    kind: llm
    title: 分镜脚本
    prompt: |
      基于已拍板的创意简报生成分镜脚本，输出 JSON：
      {"scenes":[{"no":1,"visual":"画面描述","narration":"旁白/字幕","duration_sec":8}],"total_sec":60,"production_notes":"给剪辑 agent 的技术与制作说明（工具、素材、尺寸、ffmpeg 指令要点）"}

      创意简报：
      {{.Steps.concept.output.response}}

      制作约束：用 ffmpeg + 免费素材可完成的方案；总时长 45~75 秒；分镜 5~8 个。
    system: 你是专业分镜师。只输出 JSON。

  - id: sb_gate
    kind: gate
    title: 闸门②：分镜拍板

  - id: render
    kind: agent
    session: e2e-demo
    title: 视频生成
    zombie:
      timeout: 20m
      max_attempts: 2

  - id: share
    kind: share
    title: 上传 S3

  - id: quality_gate
    kind: gate
    title: 闸门③：质量审批（发布决定）
`;

export const DEFAULT_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  'email-reply.yaml': EMAIL_REPLY_YAML,
  'video-prod.yaml': VIDEO_PROD_YAML,
};
