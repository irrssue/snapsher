# Project Rules

## Homeserver sync

This project is hosted on a homeserver, separate from the Macbook it's developed on.
After pushing changes to `main` (per the global git workflow), always sync the
homeserver checkout too:

```
ssh irrssue@homelab "cd /home/irrssue/snapsher && git pull"
```

Do this automatically after every push, without asking for confirmation.
