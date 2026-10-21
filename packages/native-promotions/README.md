# F-502 / F-503 — one offline scheme authority

The Android products execute the existing API `domains/tpm/engine.js`, bundled by `apps/api/scripts/build-native-schemes.js`. TypeScript lowers syntax for Rhino; it does not translate or replace the pricing algorithm, BigInt arithmetic, eligibility, precedence or allocation rules. Generated Java resources include a digest-checked engine manifest. Product adapters must supply only their authorized cached prices, schemes and facts; server acceptance still reauthorizes the transaction.

The lazy interpreter has no Java host access or network bindings, serializes evaluations, and bounds request size and execution time. The shared JVM fixtures exercise the compiled authority rather than a Kotlin approximation. They are not device or financial-posting proof.

## F-502 — third-party runtime

The unchanged `org.mozilla:rhino:1.9.1` runtime is licensed under Mozilla Public License 2.0. Its source and license are available at https://github.com/mozilla/rhino/tree/Rhino1_9_1_Release and https://www.mozilla.org/MPL/2.0/. Only the core interpreter is included, not Rhino tools, shell, file or process APIs. Its documented Android minimum is API 26; both products target a minimum of API 29 and use interpreted mode.
