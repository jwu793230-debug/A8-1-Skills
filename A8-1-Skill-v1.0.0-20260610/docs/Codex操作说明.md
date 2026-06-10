# Codex 操作说明

## 目标

根据用户给出的 A8 流程、业务字段和明细清单，在 A8 中稳定生成保存待发草稿，不发送。

## 操作顺序

1. 识别用户要跑的流程：集成项目创建单、集成项目立项申请、报价清单变更、存货档案新建申请-批量。
2. 按 `docs/A8四流程填报信息清单.md` 检查输入是否足够。
3. 运行前检查默认值：Codex 或操作者优先读取 `config/default-values.local.json`；如果不存在，再参考 `config/default-values.template.json` 和 `config/A8默认值配置说明.md`。
4. 运行前合并默认值并写入本次输入 JSON：用户明确提供值优先，其次材料文件，其次 local 默认值，其次 template 默认值；仍为空的关键字段必须阻断并提示人工补充。
5. 把输入保存成 UTF-8 JSON 文件，设置 `A8_ASSISTANT_INPUT_JSON_FILE`。
6. 设置运行模式：前三个流程默认 `fast`，失败后再 `normal`，必要时 `debug`；存货批量默认 `normal`，不开放 `fast`。
7. 执行对应 npm 命令。
8. 读取 `result.json`，向用户报告保存待发是否成功、是否触碰保存、是否有缺项或行级告警。

## 默认值预检规则

正式运行前，默认值按以下顺序合并：用户当前明确值 > 用户材料值 > `default-values.local.json` > `default-values.template.json` > 空值并告警。

`default-values.template.json` 是外发模板，不写现场真实值。使用方确认默认值后，应复制或生成 `default-values.local.json`。v1.0.0 采用运行前预检合并：先把默认值合并进本次输入 JSON，再设置 `A8_ASSISTANT_INPUT_JSON_FILE` 运行。

以下字段缺失时不要自动猜测：项目名称、客户、销售、商务、售前、金额、项目编号、账套、料号、数量、单价、存货名称、型号、品牌、成本。缺失时应停止保存并提示补材料。

## 安全边界

- 不发送 A8 流程。
- 不把账号密码写入文件。
- 不把验证码、运行截图、A8 草稿 ID 或真实材料写入外发文档。
- 不因保存响应不明确而自动重跑，先提醒可能已生成待发草稿。

## 命令

```powershell
npm run assist:project-create-save
npm run assist:init-apply-save
npm run assist:change-existing-save
npm run assist:inventory-batch-save
```

## 输入文件建议

长清单和中文内容统一用 JSON 文件，不建议直接塞进 PowerShell 环境变量。
