# A8 Flow Adapter Contracts

Status date: 2026-06-10

Every release adapter follows the same contract:

1. It accepts structured input.
2. It fills A8 through the browser-driven foundation.
3. It performs the available pre-save page or submit-data readback.
4. It saves to wait-send only.
5. It reports result status, artifact path, warnings, and whether the save button was touched.

## 集成项目创建单

Route: `project_create_save_draft`  
Modes: `fast`, `normal`, `debug`  
Primary inputs: project name, customer, sales, business, presales, win rate, progress, estimated amount, province, city, district.

## 集成项目立项申请

Route: `init_apply_save_draft`  
Modes: `fast`, `normal`, `debug`  
Primary inputs: linked project-create number, base fields, and material rows. Each source row remains one A8 detail row.

## 报价清单变更

Route: `change_add_save_draft`  
Modes: `fast`, `normal`, `debug`  
Primary inputs: project locator, account, business, industry, change type, fee fields, and quote rows.

## 存货档案新建申请-批量

Route: `inventory_batch_save_draft`  
Modes: `normal`, `debug`; `fast` unsupported.  
Primary inputs: business department and inventory rows. The adapter compares requested rows with `SDKgetSubmitData()` before save.

No credentials, screenshots, real project materials, or historical draft IDs belong in adapter documentation.
