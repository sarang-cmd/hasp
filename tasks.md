Hasp task list

Status: proposed. Foundry and Nightshift are selected and a sample-only dashboard preview is available. All other tasks remain open. Owners marked You require your decision or action. Owners marked Agent require access and approval where applicable. Reviewer means an independent specialist or appointed owner. Phase gates do not imply completed work.

Decisions and access

- [ ] You: Select product name. Foundry and Nightshift are the selected design directions.
- [ ] You: Approve release sequence and first release audience.
- [ ] You: Confirm browsers and desktop and mobile operating systems, including Linux support.
- [ ] You: Approve import priorities and supported source investigation.
- [ ] You: Decide hosted AI policy, provider restrictions and consent requirements.
- [ ] You: Review recovery tradeoffs and appoint a security reviewer.
- [ ] You: Provide intended domains, support and security contacts, service owners and budget limits.
- [ ] You: Connect services or grant least-privilege roles. Do not share credentials in chat.
- [ ] Agent: Verify access and network constraints before any service changes.
- [ ] Agent: Record decisions, scope, acceptance criteria and unresolved risks.

Phase 0. Foundations

- [ ] Agent: Review current vendor APIs and select supported dependencies.
- [ ] Agent: Propose monorepo structure, development setup and release process.
- [ ] Agent: Add app shells, shared packages, lockfile and reproducible build instructions.
- [ ] Agent: Configure CI, tests, dependency review and secret scanning.
- [ ] Agent: Prepare isolated staging resources within approved access and spending limits.
- [ ] Agent and Reviewer: Produce and review the threat model and detailed security design.
- [ ] You: Approve architecture, security design and phase gate.

Phase 1. Vault and web

- [ ] Agent: Implement account sessions and server authorization.
- [ ] Agent: Implement reviewed key management, encryption, lock and recovery flows.
- [ ] Agent: Implement encrypted persistence, sync, conflict handling and offline behavior.
- [ ] Agent: Build vault create, edit, delete, copy, reveal, search, labels and environment filters.
- [ ] Agent: Support backup codes and time-based one-time codes.
- [ ] Agent: Test tenant isolation, recovery, metadata exposure, accessibility and failure states with synthetic data.
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
