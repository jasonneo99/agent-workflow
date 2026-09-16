# UX Standards Guidance

Agent Workflow's product and frontend agents apply standards as part of their
normal work. This is a source-selection policy, not a copied substitute for the
authoritative publications.

## Selection order

1. Identify every target platform, form factor, input method, and assistive
   technology affected by the work.
2. Apply the platform owner's current guidance for platform behavior and
   component conventions.
3. Apply the relevant accessibility standard independently. A platform design
   system does not replace accessibility conformance.
4. Preserve explicit product requirements and established local patterns when
   they do not conflict with higher-priority safety or accessibility needs.
5. Explain intentional departures. Do not flatten every product into the visual
   style of a platform guide.

## Authoritative registry

| Scope | Primary source | Normal use |
| --- | --- | --- |
| iOS, iPadOS, macOS, watchOS, tvOS, visionOS | [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) | Native navigation, layout, components, inputs, terminology, system integration, and Apple accessibility behavior |
| Web and web applications | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) | Testable accessibility requirements, semantic roles, keyboard interaction, focus, names, states, and properties |
| Android | [Material Design 3](https://m3.material.io/) and [Android accessibility guidance](https://developer.android.com/guide/topics/ui/accessibility) | Android navigation, adaptive layout, components, motion, input, and platform accessibility behavior |
| Windows and Microsoft product surfaces | [Fluent 2](https://fluent2.microsoft.design/) and [Windows accessibility guidance](https://learn.microsoft.com/windows/apps/design/accessibility/accessibility) | Windows interaction conventions, components, content, inclusive design, and accessibility implementation |

Add another standard only with an authoritative owner, canonical URL, defined
scope, and stated relationship to the sources above. Project-local standards
belong in `docs/ui-system.md` or project context and may refine this registry,
but must not silently lower accessibility requirements.

## Evidence contract

Standards-based findings must include:

- target platform and affected journey;
- source name and specific topic or success criterion;
- observed evidence in the product or implementation;
- severity and user impact;
- concrete remediation and verification method.

Use `requirement` only for normative or policy-mandated criteria. Use
`recommendation` for platform guidance and `polish` for reasoned design judgment.
If the current authoritative source cannot be checked, mark the finding
`verification needed`; do not present remembered details as current fact.
