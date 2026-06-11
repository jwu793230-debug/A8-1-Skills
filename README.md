# A8-1 Skills

这个仓库存放 A8-1 Skill 的正式发布目录。当前版本是：

[A8-1-Skill-v1.0.0-20260610](./A8-1-Skill-v1.0.0-20260610)

## 这是做什么的

A8-1 Skill 是给 Codex 使用的 A8 自动填单工具。它根据用户提供的项目材料、清单和默认值配置，在 A8 中自动生成“保存待发”草稿。

它的核心边界很明确：

- 只保存到 A8 待发，不自动发送。
- 不在仓库中保存账号、密码、验证码、A8 草稿 ID、真实运行截图或真实项目材料。
- 默认值可以由使用方在本地维护，仓库只提供模板和说明。

## 工作流

```mermaid
flowchart LR
    A["准备材料"] --> B["确认默认值"]
    B --> C["Codex 生成本次输入 JSON"]
    C --> D["运行对应 A8 流程"]
    D --> E["保存到 A8 待发"]
    E --> F["人工复核后自行发送"]
```

## 支持流程

| A8 流程 | 支持模式 | 入口命令 |
| --- | --- | --- |
| 集成项目创建单 | fast / normal / debug | `npm run assist:project-create-save` |
| 集成项目立项申请 | fast / normal / debug | `npm run assist:init-apply-save` |
| 报价清单变更 | fast / normal / debug | `npm run assist:change-existing-save` |
| 存货档案新建申请-批量 | normal / debug | `npm run assist:inventory-batch-save` |

存货档案新建申请-批量不开放 fast 模式。

## 快速使用

1. 进入版本目录：

```powershell
cd A8-1-Skill-v1.0.0-20260610
```

2. 安装依赖：

```powershell
npm install
```

3. 运行前临时设置 A8 账号密码：

```powershell
$env:SEEYON_USERNAME = "<A8账号>"
$env:SEEYON_PASSWORD = "<A8密码>"
```

4. 设置本次输入材料：

```powershell
$env:A8_ASSISTANT_INPUT_JSON_FILE = "D:\path\to\input.json"
$env:A8_TRACE_LEVEL = "normal"
```

5. 执行对应流程，例如：

```powershell
npm run assist:init-apply-save
```

运行成功后，请到 A8 待发中人工复核草稿。

## 默认值怎么处理

正式运行前先看：

- [`config/A8默认值配置说明.xlsx`](./A8-1-Skill-v1.0.0-20260610/config/A8默认值配置说明.xlsx)
- [`config/default-values.template.json`](./A8-1-Skill-v1.0.0-20260610/config/default-values.template.json)

推荐逻辑：

```text
用户当前明确说明 > 用户材料里的值 > default-values.local.json > default-values.template.json > 空值告警
```

`default-values.local.json` 是使用方本地文件，不应提交到仓库。

## 文档入口

- [版本 README](./A8-1-Skill-v1.0.0-20260610/README.md)
- [Codex 操作说明](./A8-1-Skill-v1.0.0-20260610/docs/Codex操作说明.md)
- [四流程填报信息清单 Excel](./A8-1-Skill-v1.0.0-20260610/docs/A8四流程填报信息清单.xlsx)
- [默认值配置说明 Excel](./A8-1-Skill-v1.0.0-20260610/config/A8默认值配置说明.xlsx)
- [发布验证报告](./A8-1-Skill-v1.0.0-20260610/docs/发布验证报告.md)
- [发版资料总览 HTML](./A8-1-Skill-v1.0.0-20260610/docs/A8-1发版资料总览.html)
- [给同事的压缩包使用说明](./A8-1-Skill-v1.0.0-20260610/docs/给同事的压缩包使用说明.txt)

## 发布验证结论

v1.0.0 已完成真实 A8 保存待发冒烟：

- 集成项目创建单：fast 通过。
- 集成项目立项申请：全量 fast 通过。
- 报价清单变更：fast 通过。
- 存货档案新建申请-批量：normal 通过。

四个流程均只保存待发，不发送。

## 仓库边界

仓库只保存正式版源码、配置模板和说明文档。不上传：

- zip 压缩包
- `runtime/`
- `node_modules/`
- Chrome profile
- cache
- 截图、日志、HTML dump
- A8 草稿 ID
- 账号密码、验证码
- 真实项目材料
