# Hasp

A vault for API keys, backup codes and one-time codes, with a browser extension, a web dashboard, a desktop app and a mobile app.

This repository contains the design exploration, implementation plan and an early Foundry and Nightshift dashboard preview. The preview uses sample metadata only. Secure storage, accounts and sync are not implemented. Do not enter real secrets. Twelve design directions, six light and six dark, include 72 rendered images.

Run the dashboard locally with Node.js 18 or later. Run `npm run dev`, then open `http://localhost:3000`. Run `npm test` for the filtering tests. No external packages or credentials are required. Use the design and mode selectors to choose Foundry or Nightshift in light or dark mode. The browser remembers each design's mode locally when storage is available.

- `mockups/browse.html` is the browser: filter light or dark, open a direction, see every screen.
- `mockups/index.html` lists twelve visual directions.
- `mockups/gallery.html` shows all 72 rendered mockup images.
- `mockups/brands.html` lists the 586 company marks used in the mockups, with search and category filters.
- `mockups/png/` holds the images.
- `PLAN.md` covers the earlier architecture proposal, crypto, imports, security and phases.
- `IMPLEMENTATION_REVIEW.md` sets out the proposed delivery plan and decisions for review.
- `STEP_BY_STEP.md` explains the sequence and actions required from you and the agent.
- `tasks.md` tracks the proposed work and approval gates.
- `DEPLOYMENT.txt` covers deployment of the existing preview and future release preparation.

Every key, code, and account row carries the real mark of its company. Marks come from the Simple Icons and SVG Logos sets, bundled with the repo, so the pages load with no network. Brand colours are the published values.

Sample vault data appears throughout. All keys are invented.
