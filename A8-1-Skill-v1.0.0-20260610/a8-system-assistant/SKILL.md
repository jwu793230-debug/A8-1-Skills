---
name: a8-system-assistant
description: Shared browser-driven foundation for the A8-1 release candidate. Use through the root a8-1-skill wrapper unless maintaining internals.
---

# A8 System Assistant

This folder contains the shared execution foundation used by A8-1 Skill.

Supported release routes:

- `change_add_save_draft`
- `init_apply_save_draft`
- `project_create_save_draft`
- `inventory_batch_save_draft`
- `project_create_observe`
- `project_create_control_observe`
- `inventory_batch_observe`

Release boundaries:

- Save to wait-send only.
- Never send.
- Never persist credentials.
- Never include runtime artifacts in an external package.
- Inventory batch supports only `normal` and `debug`; `fast` remains closed.

Read:

- `references/flows.md`
- `references/adapter-contracts.md`
- `references/recovery-rules.md`
