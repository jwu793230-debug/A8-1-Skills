# A8 Flow Status Registry

Status date: 2026-06-10

This release candidate exposes four save-to-wait-send routes and three observation routes. It does not expose send, delete, cleanup, or historical diagnostic routes.

| Business flow | Route | Status | Modes | Save policy |
| --- | --- | --- | --- | --- |
| 集成项目创建单 | `project_create_save_draft` | Mature | `fast`, `normal`, `debug` | Save to wait-send only after explicit user request and pre-save readback. |
| 集成项目立项申请 | `init_apply_save_draft` | Mature | `fast`, `normal`, `debug` | Save to wait-send only after explicit user request and row sanity checks. |
| 报价清单变更 | `change_add_save_draft` | Mature | `fast`, `normal`, `debug` | Save to wait-send only after explicit user request and row sanity checks. |
| 存货档案新建申请-批量 | `inventory_batch_save_draft` | Mature in declared modes | `normal`, `debug` | `fast` is intentionally refused; save only after submit-data readback passes. |

Observation routes:

- `project_create_observe`
- `project_create_control_observe`
- `inventory_batch_observe`

No historical A8 draft IDs are included in this release registry.
