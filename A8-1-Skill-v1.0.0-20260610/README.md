# A8-1 Skill v1.0.0

本目录是 A8-1 Skill v1.0.0 正式版，用于让 Codex 根据用户提供的项目资料、清单和默认配置，自动在 A8 中生成“保存待发”草稿。

## 安装

1. 在本目录打开 PowerShell。
2. 执行 `npm install`。
3. 确认本机已安装 Google Chrome。
4. 运行前只在当前 PowerShell 或当前 Codex 会话里提供 A8 账号密码：

```powershell
$env:SEEYON_USERNAME = "<A8账号>"
$env:SEEYON_PASSWORD = "<A8密码>"
```

## 支持范围

| A8流程 | 支持模式 | 入口命令 |
| --- | --- | --- |
| 集成项目创建单 | fast / normal / debug | `npm run assist:project-create-save` |
| 集成项目立项申请 | fast / normal / debug | `npm run assist:init-apply-save` |
| 报价清单变更 | fast / normal / debug | `npm run assist:change-existing-save` |
| 存货档案新建申请-批量 | normal / debug | `npm run assist:inventory-batch-save` |

所有入口只保存到 A8 待发，不发送。

2026-06-10 发布冒烟结论：集成项目创建单 `fast`、集成项目立项申请全量 `fast`、报价清单变更 `fast`、存货档案新建申请-批量 `normal` 均已真实保存待发通过。

## 给材料的方式

推荐把材料整理为 UTF-8 JSON 文件，然后设置：

```powershell
$env:A8_ASSISTANT_INPUT_JSON_FILE = "D:\path\to\input.json"
$env:A8_TRACE_LEVEL = "fast"
npm run assist:change-existing-save
```

字段清单见 `docs/A8四流程填报信息清单.md`。默认值说明见 `config/A8默认值配置说明.md`。

## 正式运行前默认值

1. 打开 `config/A8默认值配置说明.xlsx`，在“建议修改为”和“是否启用”列确认现场默认值。
2. 保留 `config/default-values.template.json` 不动，复制一份本地 `config/default-values.local.json` 保存现场默认值。
3. 正式运行前由 Codex 或操作者按“用户明确值 > 用户材料 > local 默认值 > template 默认值 > 空值告警”的顺序合并，写入本次 `A8_ASSISTANT_INPUT_JSON_FILE`。
4. `default-values.local.json` 不进入外发包；账号、密码、验证码、草稿 ID 和真实项目材料也不写入默认值文件。

## 打包边界

外发包不应包含 `runtime/`、`node_modules/`、截图、HTML dump、Chrome profile、真实项目材料、账号密码、草稿 ID 或历史观察日志。
