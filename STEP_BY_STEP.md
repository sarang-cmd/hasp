Step-by-step guide

Start here

The repository contains mockups and a local web vault prototype. The prototype is not audited or production ready. Use synthetic data only. The implementation plan is a proposal for your approval. Do not expose the prototype to untrusted networks or use the mockup deployment as a vault. See DEPLOYMENT.txt for the local preview warning.

Step 1. Review and decide.

You: Read IMPLEMENTATION_REVIEW.md. Confirm the release order, target audience, supported platforms and import priorities. Hasp is the working name, with Foundry and Nightshift selected in light and dark modes. Decide whether hosted AI is permitted. Review the recovery tradeoff and identify a security reviewer. Provide the intended domains, support contact, account owners and monthly budget limits. Approve or amend the scope before implementation starts.

Agent: Record approved decisions, open questions, acceptance criteria and changes to the task list. Flag decisions that need a specialist rather than inventing an answer.

Step 2. Arrange access without sharing keys in chat.

You: Connect the services you want the agent to use, or invite a limited-access project identity in each provider. Approve access to the repository and selected staging resources. Add secrets directly in the relevant provider's secure settings when implementation identifies the exact names and values. Confirm setup without sending the values. Keep billing, domain ownership, recovery, signing and final approval under your control.

Agent: Check each connected service and effective permissions. Explain any missing permission or network restriction. Request the minimum access needed for a specific task. Never request passwords, API keys, recovery codes, private keys or two-factor codes in chat. Do not commit credentials or print them in logs.

Step 3. Establish the engineering baseline.

Agent: Inspect the existing Node prototype and tests. Propose whether to reuse, replace or migrate the current code, then agree on the target repository layout, supported runtime versions and build commands. Create missing app shells, shared packages and automated checks after scope approval. Document how to run, test and build locally. Configure CI with synthetic data and no production credentials.

You: Review the proposed stack and approve any paid tools or account changes. Approve the initial design and release criteria.

Step 4. Prepare isolated staging infrastructure.

You: Approve staging domain names and the services to provision. Complete provider invitations, billing verification, MFA and DNS ownership challenges when required. Set a budget and billing alerts.

Agent: Where authorized and technically possible, configure staging resources and document non-secret identifiers, owners, roles and environment variable names. Use separate staging data and credentials. Verify deployment, access restrictions, logging and backups. If access or egress blocks a step, provide exact instructions for you rather than claiming completion.

Step 5. Design and review vault security.

Agent: Review the existing threat model in SECURITY.md and produce a detailed target design covering keys, encryption, recovery, device access, authorization, metadata, sync and AI data flow. Document how the prototype differs, including its server-side cryptography and sample password. Build test vectors and plan platform compatibility. Reconcile the proposal with PLAN.md.

You: Review the user-facing recovery tradeoffs and commission or identify an independent security reviewer. Approve the security model and explicitly accept any documented limitations before real data is used.

Step 6. Build web and extension.

Agent: Implement the shared vault, authentication, encrypted sync and web flows. Build the extension with site matching, a shortcut overlay and explicit fill. Use synthetic records throughout. Add tests for access isolation, conflicts, recovery, keyboard navigation, responsive layout and unsafe fill scenarios. Deliver staging previews for review.

You: Review the screens, workflows and acceptance results. Confirm supported browsers and approve changes to permissions or scope.

Step 7. Add import and labeling.

Agent: Test source formats against synthetic exports. Build local parsing, duplicate handling and a review screen. Document unsupported or version-dependent authenticator formats. Implement hosted AI only if approved, with explicit consent, provider review and tests of the data leaving the device.

You: Approve the supported format list and AI policy. Supply sanitized or synthetic examples only if needed. Never upload a real vault export for debugging.

Step 8. Build desktop and mobile.

Agent: Build and test signed release candidates for the approved operating systems. Implement offline behavior, recovery and secure updates. Prepare store metadata and draft privacy disclosures.

You: Set up or grant access to developer and store accounts, approve listing text, arrange signing credentials in the platform's secure systems and complete any identity verification or legal agreements. Confirm Linux desktop support and the rollout order.

Step 9. Review operations and security.

Agent: Run the release checks, document remaining risks, restore a backup in an isolated environment, verify monitoring and rehearse rollback and incident response. Provide the independent reviewer with architecture and test evidence, without disclosing user secrets.

You: Arrange independent security and legal review. Review findings, fund remediation and approve or reject documented residual risks. Provide support and security contacts.

Step 10. Prepare production and launch.

You: Approve production provisioning, domains, live billing if applicable, store submissions and a specific go-live decision. Provide budget limits and an escalation owner.

Agent: Configure approved production resources within available permissions, verify environment separation and security settings, deploy a reviewed build and perform synthetic end-to-end checks. Stage the rollout, monitor service health and follow the rollback plan. Report unfinished steps and any actions requiring your approval.

Review rhythm

Review the task list at each phase gate. Work on later phases may be prepared in parallel, but do not treat a gate as passed until evidence exists and its owner approves it. Update tasks.md as work progresses. No delivery dates are committed until scope and dependencies are estimated.
