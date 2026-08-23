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
  (cd app && npm run build) && (cd server && npm run build) && \
  pm2 restart snapsher"
```

Do this automatically after every push, without asking for confirmation.
