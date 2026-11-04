Hasp implementation plan for review

Status: proposed. The repository contains design mockups and a local web vault prototype. The prototype is for synthetic data only and is not ready for production or real secrets. The repository does not establish whether any external infrastructure has been provisioned.

Purpose

Build a secret manager for API keys, personal access tokens, backup codes and one-time codes. Users organize secrets by service and environment. A browser extension offers an explicit suggestion and fill action. Web, desktop and mobile clients share a vault and sync encrypted data.

Decisions for your review

1. Release order. Recommended: web dashboard and browser extension first, then desktop, then mobile. You requested all four surfaces. This order delivers all four in stages, not a reduced final scope. Please approve or change the order.
2. Name and design. Hasp is the working name. Foundry and Nightshift are selected, with light and dark modes for each. Check trademark and domain availability before a public launch.
3. First release audience. Choose internal testing, invited beta, or public release. Recommended: internal testing with synthetic data, followed by a limited beta only after security review.
4. Client encryption and recovery. Approve a client-side encryption model and recovery approach after a security specialist reviews the detailed design. Decide whether losing both the master password and recovery key means permanent loss of vault access. Do not promise zero knowledge until the implementation and metadata exposure are verified.
5. AI processing. Choose whether hosted AI labeling is allowed, whether it is enabled in the first release, and which provider and region are acceptable. Recommended: local rules first, hosted processing disabled until explicit opt-in and a reviewed data flow exist. Redaction alone does not guarantee removal of secrets.
6. Accounts and costs. Identify owners for the Neon, Vercel, Cloudflare, Resend, PostHog, Stripe, 9Router, Linear, app store and code-signing accounts. Set monthly budgets and an approval limit before paid services are enabled. Stripe remains test-only until you approve pricing and live billing.
7. Domains and email. Provide the intended application and staging hostnames, sending domain, support address and security contact. Domain ownership and DNS changes need your approval or delegated access.
8. Platform scope. Confirm supported browsers and the first desktop and mobile operating systems. Proposed: Chrome and Edge first, Firefox after compatibility review, then Windows and macOS desktop and Android and iOS mobile. Linux desktop support needs a separate packaging and support decision to satisfy the cross-platform scope.
9. Import scope. Approve the supported source formats after sample exports with synthetic data are tested. Google Keep Takeout and standard otpauth URIs are initial targets. Google and Microsoft Authenticator export capabilities vary by version and platform. Verify each current export flow before making compatibility claims. Do not provide real exported secrets for testing.
10. Legal and privacy. Supply or approve the business identity, privacy choices, support process and legal review owner. Legal text is a draft until counsel reviews it.

Architecture proposal

Consider a TypeScript monorepo after review. The current prototype is a single Node.js package, not the proposed monorepo. Share item models, validation, cryptographic interfaces, import parsers and test vectors across clients. Use a web app and API hosted on Vercel, Neon Postgres and Neon Auth for identity and sync, and Cloudflare DNS. Add R2 only where a reviewed file workflow needs it. Add Resend for transactional email, PostHog for privacy-reviewed events, Stripe for billing when approved, and 9Router for optional AI processing. Linear tracks work if connected and authorized.

The current prototype performs cryptographic operations on the Node server, and plaintext passes between the browser and server. It is not the proposed client-side encryption architecture. It uses a seeded sample password, scrypt and ChaCha20-Poly1305 with a 12-byte nonce. Sessions, throttling and pending imports are process-local. It is not a hosted multi-user service. The implementation agent must review whether to replace or migrate the prototype before accepting real data.

The existing PLAN.md contains an earlier architecture proposal, including specific cryptographic choices, sync rules and schedules. Treat those as candidates, not implemented guarantees. Resolve differences in an approved technical design before coding. In particular, define authentication separately from vault key custody, document visible metadata and avoid claiming encrypted backups or recovery without tested implementations.

Delivery phases

Phase 0. Confirm scope and foundations.
Record the remaining decisions above, confirm the selected designs, threat model and acceptance criteria. Set up the repository, isolated development and staging environments, CI, dependency scanning and a release process. Confirm current vendor APIs and platform requirements before selecting SDK versions.
Exit: reviewed architecture and threat model, reproducible builds, test environments and named owners. No real customer secrets.

Phase 1. Shared vault and web dashboard.
Assess the existing prototype and identify reusable code before implementing the target architecture. Implement account sessions, reviewed key derivation and encryption, local vault operations, encrypted sync, conflict handling, search, labels, environment selection, backup codes and time-based one-time codes. Add create, edit, delete, reveal, copy, lock and recovery flows. Test authorization, offline behavior, recovery and accessibility. For the proposed client-side encryption architecture, the server must not receive plaintext secret values through normal vault operations. The current prototype does not meet this target.
Exit: end-to-end tests with synthetic data, verified access isolation, tested recovery and security review of the cryptographic implementation.

Phase 2. Browser extension.
Build a browser popup and keyboard shortcut overlay. Match the active site and present a clear suggestion with its reason. Fill only after an explicit user action. Handle multiple environments and refuse unsafe or ambiguous fills. Limit permissions, review origin handling and meet store policies.
Exit: security and accessibility tests on supported browsers, store-ready packages and an internal test release.

Phase 3. Imports and optional labeling.
Implement local parsing and review for supported Google Keep exports and tested authenticator formats. Detect duplicates, show the user what will be imported, and encrypt accepted items before sync. Offer local labeling first. Any hosted AI path requires separate opt-in, data-flow review and provider terms. A malformed file must not expose data through errors or logs.
Exit: format fixtures made from synthetic data, error and duplicate tests, documented source limitations and approved privacy behavior.

Phase 4. Desktop.
Build the Electron shell, local encrypted storage, global shortcut, offline and sync behavior, signed update flow and installers. Prepare Microsoft Store packaging. Address Windows, macOS and the agreed Linux support decision.
Exit: install, upgrade, rollback, recovery and offline tests on each supported operating system. Complete signing and store requirements before release.

Phase 5. Mobile.
Build mobile vault and one-time code flows with device secure storage, biometric unlock where supported, encrypted local data and sync. Test device loss and recovery. Prepare Android and iOS store submissions.
Exit: supported-device tests, accessibility review, signed builds, privacy disclosures and store review.

Phase 6. Hardening and launch.
Complete independent security review, restore exercises, incident response, legal review, operational monitoring and staged rollout. Validate billing only if approved. Test the full user journey with synthetic data, then obtain a separate go-live decision.
Exit: critical findings resolved, known risks accepted by their owners, support and rollback ready, and your explicit launch approval.

Security and operational gates

Document the threat model, key lifecycle, encryption parameters, recovery limitations, server-visible metadata, authorization and sync conflict behavior. Require automated tests, dependency and secret scanning, peer review and reproducible builds. Test backups by restoring into an isolated environment. Configure least-privilege access, MFA, cost alerts and an incident owner. Never put secrets, recovery keys or plaintext vault values in logs, analytics, issue trackers, AI prompts or test fixtures.

External security review is a launch gate, not a substitute for secure implementation. No release dates or security certifications are assumed. Scope and estimates should be reviewed after the decisions and technical investigation.

Access and credentials

Do not send API keys, passwords, recovery codes or private signing keys in chat or repository files. Prefer granting the minimum required access through the connected app, provider role or project invitation. Enter any required secrets directly into the provider's secure environment settings. Tell the agent when configuration is complete, without disclosing values. The agent must verify available permissions and network access before promising to configure a service. Some actions, such as billing approval, legal acceptance, DNS ownership, MFA, signing and app store submission, may require you to act.

Related documents

STEP_BY_STEP.md explains the working sequence and identifies who acts. tasks.md tracks work and review gates. DEPLOYMENT.txt covers the existing static design preview. PLAN.md contains the earlier technical proposal and mockup notes.
