# Provider credit measurement

`agentflow provider-credits` queries supported, configured provider endpoints
and reports scrubbed account-scoped observations. Add `--persist` to retain the
latest observation in storage. MCP exposes `agentflow_provider_credits` as a
read-only measurement tool; it does not persist or perform inference. `--providers deepseek,openrouter` selects an
exact bounded provider list. These calls do not purchase funds, create accounts,
change providers, or authorize inference.

Supported measurements:

| Provider | Measurement | Boundary |
| --- | --- | --- |
| DeepSeek | Reported USD or CNY balance and API availability | CNY is never converted into an invented USD balance. |
| OpenRouter | Current-key spending cap; account credits only when the key reports management capability | A spending cap or unlimited key is not proof of account funds. |
| Other providers | Explicit unknown with an unsupported-API reason | Subscription access, successful inference and usage totals do not establish a prepaid balance. |

The collector uses only already-configured provider credentials, qualifies the
configured origin before dispatch, refuses redirects, bounds response size and
request time, and never returns raw API response bodies or diagnostic strings.
A custom gateway remains unqualified until its own balance contract is supplied.

Storage keys use the same opaque account identity as provider availability.
Observations for another account cannot supply current-account funds. Older or
duplicate observations cannot replace a newer observation. A later unsuccessful
measurement replaces the current value with unknown, rather than carrying an
old numeric amount forward as fresh. Only measured USD balances observed within
five minutes qualify as current USD evidence; future and stale timestamps do
not. Storage drops extra fields and restricts public reasons and sources.

The read-only CLI is an operator measurement surface. Persistence is observation,
not acceptance or execution authority. A measurement does not bypass project
provider/data policy, quality qualification, or ordinary approval gates.

API contracts:

- [DeepSeek user balance](https://api-docs.deepseek.com/api/get-user-balance/)
- [OpenRouter current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [OpenRouter account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)

Adaptive routing reads durable measurements for the current account, caps known
funds by a reported limit only when its opaque credential identity matches, and strips financial claims supplied only in prompt
text. It does not make network requests during route selection. Recurring
collection and installed-runtime adoption must be verified separately from the
collector, storage and routing tests. Unsupported balances remain unknown.

Codex CLI native quota coverage is a remaining qualification item. Its documented
[app-server account meter](https://learn.chatgpt.com/docs/app-server) can report
usage windows and optional provider-native credits. Those units must remain
separate from USD balance measurements, and missing fields must remain unknown.
