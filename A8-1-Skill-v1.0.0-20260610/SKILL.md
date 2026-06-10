---
name: a8-1-skill
description: "Use when the user asks Codex to create A8 wait-send drafts for the supported A8-1 workflows: project creation, project initiation, quote-list change, and inventory batch creation. This release only saves drafts to wait-send and never sends them."
---

# A8-1 Skill

This is the release candidate for the A8-1 wait-send draft assistant.

## First Rules

- Never send an A8 workflow. Only save to wait-send.
- Never store A8 usernames, passwords, captcha codes, screenshots, draft IDs, runtime results, or user project materials in long-lived files.
- Ask for A8 credentials only when they are missing from the current conversation or process environment.
- Prefer HTTP login first. If A8 rejects the HTTP session, use the built-in headless browser form-login fallback.
- If captcha appears, use the generated captcha screenshot and one-time captcha input file or `A8_LOGIN_VERIFY_CODE`.
- Use explicit user input first, then provided Excel/JSON materials, then documented defaults, then blank values with warnings.

## Supported Save Routes

Run from this skill folder.

```powershell
npm run assist:project-create-save
npm run assist:init-apply-save
npm run assist:change-existing-save
npm run assist:inventory-batch-save
```

Supported runtime modes:

- `project_create_save_draft`: `fast`, `normal`, `debug`
- `init_apply_save_draft`: `fast`, `normal`, `debug`
- `change_add_save_draft`: `fast`, `normal`, `debug`
- `inventory_batch_save_draft`: `normal`, `debug` only. Do not use `fast`.

## Input

Prefer `A8_ASSISTANT_INPUT_JSON_FILE` for Chinese text and long row lists.

```powershell
$env:A8_ASSISTANT_INPUT_JSON_FILE = "D:\path\to\input.json"
$env:A8_TRACE_LEVEL = "fast"
npm run assist:init-apply-save
```

See `README.md`, `docs/`, and `config/` for human-readable input and default-value documentation.

## Runtime Output

Runs create local artifacts under `runtime/`. These artifacts are for the operator only and must be deleted before sharing a package.
