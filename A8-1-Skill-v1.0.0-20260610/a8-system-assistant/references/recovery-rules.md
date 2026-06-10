# Recovery Rules

Shared release recovery rules:

- Report success only when the save-draft action returns a successful result and the available pre-save/readback gate passed.
- If a save response is uncertain, stop and report the artifact path. Do not automatically rerun because a wait-send draft may already exist.
- If a bad draft is suspected, report the evidence and ask for explicit cleanup approval. Cleanup is not part of the release save routes.
- Never send, delete, or clean A8 items unless the user explicitly asks for that specific action.
