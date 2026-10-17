# Dependency patches

`decode-uri-component@0.2.2.patch` backports the linear UTF-8 decoder from the MIT-licensed
[`decode-uri-component` 0.5.0](https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.0)
for [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
It retains the 0.2.2 CommonJS export, plus-to-space conversion and malformed-byte replacement wrapper required by
`query-string@7.1.3` in the legacy WalletConnect dependency tree. The package license remains in the installed package.

`scripts/dependency-security.test.mjs` checks compatibility and bounds a long malformed-input regression with a child
process timeout. Bun's version-based audit still reports the advisory; this patch is its disposition, not an audit
suppression. Remove it when the upstream wallet tree consumes a fixed compatible decoder.
