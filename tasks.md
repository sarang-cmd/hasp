Hasp task list

Status: in progress. Checked items identify limited prototype work or recorded design choices, not production readiness. An unchecked item remains open until every part and its review gate is complete. Owners marked You require your decision or action. Reviewer means an independent specialist
or appointed owner; no security review has happened.

All twelve design directions are as delivered. Foundry and Nightshift were then chosen and built.

Decisions and access

- [x] You: Select product name and design direction. Hasp, Nightshift with Foundry, both with light and dark.
- [x] You (revised): Nightshift is the default surface; Foundry remains one click away.
- [ ] You: Approve release sequence and first release audience. Web dashboard built first, on the proposed order.
- [ ] You: Confirm browsers and desktop and mobile operating systems, including Linux support.
- [ ] You: Approve import priorities and supported source investigation.
- [ ] You: Decide hosted AI policy, provider restrictions and consent requirements.
- [ ] You: Review recovery tradeoffs and appoint a security reviewer.
- [ ] You: Provide intended domains, support and security contacts, service owners and budget limits.
- [ ] You: Connect services or grant least-privilege roles. Do not share credentials in chat.
- [ ] Agent: Verify access and network constraints before any service changes.
- [ ] Agent: Record decisions, scope, acceptance criteria and unresolved risks.

Phase 0. Foundations

- [ ] Agent: Review current vendor APIs and select supported dependencies. A Node prototype and lockfile exist; vendor API review and target dependency selection remain open.
- [ ] Agent: Review the existing single package and propose the target repository layout, development setup and release process.
- [ ] Agent: Add missing app shells and shared packages. A web prototype, lockfile and local run instructions exist.
- [ ] Agent: Configure CI, tests, dependency review and secret scanning. Tests and a lockfile exist; CI does not.
- [ ] Agent: Prepare isolated staging resources within approved access and spending limits.
- [ ] Agent and Reviewer: Produce and review the threat model and detailed security design. SECURITY.md contains a prototype threat model. The target design and independent review remain open.
- [ ] You: Approve architecture, security design and phase gate.

Phase 1. Vault and web

- [ ] Agent: Implement account sessions and server authorization. Sessions exist; accounts do not.
- [ ] Agent: Implement and independently review target key management, encryption, lock and recovery flows. The prototype has encryption and locking, but uses server-side cryptography and has not been independently reviewed. Recovery remains to be designed and verified.
- [ ] Agent: Implement encrypted persistence, sync, conflict handling and offline behavior. Persistence and per item versions exist; no sync, no conflict handling, no offline.
- [ ] Agent: Complete production-ready vault create, edit, delete, copy, reveal, search, labels and environment filters. Prototype flows exist and need target architecture and security review.
- [ ] Agent: Complete reviewed backup code and time-based one-time code support. Prototype flows and tests exist.
- [ ] Agent: Test tenant isolation, recovery, metadata exposure, accessibility and failure states with synthetic data. Existing prototype tests do not establish all of these gates.
- [ ] Reviewer: Review security implementation and findings.
- [ ] You: Review staging and approve phase gate.

Phase 2. Browser extension

- [ ] Agent: Build popup, search and keyboard shortcut overlay.
- [ ] Agent: Implement site matching, explainable selection and explicit user-initiated fill.
- [ ] Agent: Test permission boundaries, untrusted pages and ambiguous environments.
- [ ] Agent: Build packages and verify browser store requirements.
- [ ] You: Approve permissions, supported browsers and internal release.

Phase 3. Import and labeling

- [ ] Agent: Verify current Google Keep and authenticator export formats using synthetic fixtures.
- [ ] Agent: Build local parsing, review, duplicate detection and encrypted import.
- [ ] Agent: Document unsupported or version-dependent formats and test failure paths.
- [ ] Agent: Build local labeling rules.
- [ ] You: Approve any hosted AI data flow and provider terms before implementation.
- [ ] Agent: If approved, implement opt-in hosted labeling and test consent and data handling.
- [ ] You: Review import results and approve phase gate.

Phase 4. Desktop

- [ ] Agent: Build Electron client, encrypted local storage, offline sync and global shortcut.
- [ ] Agent: Implement verified updates and installers for approved operating systems.
- [ ] You: Arrange secure signing access and Microsoft Store account requirements.
- [ ] Agent: Test installation, update, rollback and recovery. Prepare MSIX submission.
- [ ] You: Review release candidate and approve phase gate.

Phase 5. Mobile

- [ ] Agent: Build mobile vault and one-time code flows with secure storage and biometrics where supported.
- [ ] Agent: Test sync, device loss, recovery and accessibility on supported devices.
- [ ] You: Arrange developer accounts, secure signing and store identity verification.
- [ ] Agent: Prepare signed builds and draft store disclosures.
- [ ] You: Review release candidate and approve phase gate.

Phase 6. Production and launch

- [ ] Agent: Configure approved production environments and least-privilege access.
- [ ] Agent: Test backups and isolated restoration, alerts, incident response and rollback.
- [ ] Reviewer: Complete independent security review. Resolve critical findings.
- [ ] You and legal reviewer: Review privacy, terms, store disclosures and brand usage.
- [ ] Agent: Verify production domains, TLS, email, auth, monitoring and synthetic end-to-end flows.
- [ ] You: Approve pricing and live Stripe use if billing is in scope.
- [ ] You: Approve production release, store submissions and staged rollout.
- [ ] Agent: Deploy the reviewed build, monitor the rollout and report remaining issues.
