# Release after a pilot (only on the user's explicit request)

A pilot never deploys on its own. When the user asks to ship what the pilot merged:

1. **Fix red checks first.** A smoke check red on main is fixed in its own commit with the
   reason (e.g. an EXPECT token mismatch) before the build.
2. **Build.** Check the open Creator has imported the merged assets: compare the
   `library/<uuid>` mtimes of the scene and new prefabs with the merge time. Then run
   `OG_BASE_URL=<prod url> build/build.sh --clean` and confirm `build-info.json` and the
   absolute og:image.
3. **Local smoke.** Serve `build/web-mobile` on a free port (check with `lsof` first; never
   reuse another project's server). Open a fresh Orca tab with `--worktree path:<project>`
   and run `run-smoke.mjs --port <p> --page <id> --expect-title "<title>" --viewport
   720x1280`. All checks must pass.
4. **Deploy from a temp dir without git.**
   - Copy the build in, delete any `.vercel`, run `npx vercel link --project <name> --scope <team> --yes`, then delete `.env.local` and `.gitignore`.
   - Then `npx vercel deploy --prod --yes --scope <team>`.
   - Never deploy through a `build/.vercel` link that points at another project.
5. **Prod smoke.**
   - Run `--attach-only --page <id>` at 720×1280 and 390×844.
   - Run a baseline-bound check (e.g. a look probe) at its own viewport.
   - Confirm `<url>/.env.local` returns 404.
   - Save the JSONs under `docs/evidence/release-vX.Y.Z/`.
6. **Record.** Add a retro section (build, deploy id, smoke numbers, incidents), update FOLLOWUPS, commit, and create a local tag. Push and push tags only when asked.
7. **Device rows.** Group the deferred manual rows into `docs/evidence/device-checklist-vX.Y.Z.md` (steps, what to look for, source rows, iPhone/Android columns) for the director.
8. **Cleanup.** Close the Orca tabs you opened, after checking `orca tab list --worktree path:<project>`. Stop your server and remove the temp dirs.
