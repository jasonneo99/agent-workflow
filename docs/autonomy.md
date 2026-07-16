# Autonomy Policy

Autonomy is explicit and project-scoped.

| Level | Meaning |
| --- | --- |
| 0 | Advisory only |
| 1 | Draft artifacts |
| 2 | Edit local files |
| 3 | Run local commands and tests |
| 4 | Update external systems with approval |
| 5 | Trusted scheduled automation |
| wide-open | All configured local and external actions are allowed |

`wide-open` is intended for owners who want maximum automation. It should still write receipts for every action. Shared projects can disable it by setting `allow_wide_open: false`.

