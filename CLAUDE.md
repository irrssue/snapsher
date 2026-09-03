# Project Rules

## Homeserver sync

This project is hosted on a homeserver, separate from the Macbook it's developed on.
The homeserver runs a built copy of the app (`app/dist`, `server/dist`) via PM2
(process name `snapsher`) — these build outputs are not checked into git, so a
`git pull` alone does not update what's actually being served.

After pushing changes to `main` (per the global git workflow), always sync AND
rebuild the homeserver checkout:

```
ssh irrssue@homelab "cd /home/irrssue/snapsher && git pull && \
  (cd app && npm ci && npm run build) && \
  (cd server && npm ci && npm run build) && \
  pm2 restart snapsher"
```

`npm ci` is **not** optional any more, and it is a full install rather than
`--omit=dev`: both build steps are `tsc`/`vite`, which live in
`devDependencies`, so a production-only install removes the very tools the
build needs. Until this was added, the homeserver's `node_modules` was frozen
at whatever had been hand-installed, which meant no dependency security patch
could ever reach production — and it silently ran a different Express major
than the source targeted.

Do this automatically after every push, without asking for confirmation.

## Agent usage

Do not spawn subagents/agents (Agent tool, Task tool, etc.) for work in this
project unless the user explicitly asks for it in that message. Do all
research, implementation, and file edits directly and inline.
