# Plan editing

Copy `assets/plan.json`, then replace every value from confirmed repository evidence.

`reward` is either `null` or Ship's existing reward object:

```json
{
  "startsAt": "2026-10-01T00:00:00.000Z",
  "token": {"address": "0x...", "decimals": 6, "symbol": "USDC"},
  "monthlyPoolBaseUnits": "1000000"
}
```

Do not use this skill to invent or change reward terms. `allowedModels` uses Ship's existing `{client, provider, model}` tuples. Leave it empty only when the owner intentionally offers no receipt-based compute bonus.

Keep `mission`, `guide`, and evidence lines short and operational. The validator rejects unknown fields, unsafe commands, contradictory labels, unsupported modes, placeholders, and missing policy for enabled modes.