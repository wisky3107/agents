# Shared Playwright

One Playwright install for every Cocos project. `run-smoke.mjs --channel chrome|auto` and the
Chrome headless runtime review (`cocos-orca-fleet/reference/orca/frozen-tab.md`) resolve it in
this order: `PLAYWRIGHT_MODULE`, the project's `node_modules/playwright`, then
`~/.agents/tools/playwright/node_modules/playwright`.

Install or update once per machine: `npm i --prefix ~/.agents/tools/playwright playwright`.
No browser download is needed: the launch uses the system Google Chrome (`channel: 'chrome'`,
`--use-angle=metal --enable-gpu --ignore-gpu-blocklist`). Without Chrome, run
`npx --prefix ~/.agents/tools/playwright playwright install chromium`; fps and GPU numbers from
that chromium are not representative.
