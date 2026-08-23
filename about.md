# Snapsher

## What this is

Snapsher is a small, minimal social media app built around a single idea:
**you can only share one photo every 12 hours.**

That constraint is the entire product. There is no feed-scrolling addiction
loop, no engagement-farming metrics, no vanity numbers. Just one photo,
once every half-day, per person.

## Core rules

- Users can only share **photos** — no video, no text-only posts, no links.
- A user may post **one photo per 12 hours**.
- After posting, the app shows a **countdown** until the user is allowed to
  post again. The countdown is enforced server-side ("from our end"), not
  just a UI suggestion.

## Deliberately excluded (for now)

To keep the app from turning into another over-simulating, metrics-driven
social feed, the first stage intentionally leaves out:

- No like **counts**.
- No comment **counts**.
- No share button, at all.

## What IS included, despite the above

There **is** a like button and a comment button — they exist as actions,
just without any visible counts attached to them. You can like a post or
comment on it, but you won't see "24 likes" or "8 comments" anywhere. The
interaction exists; the score-keeping doesn't.

## Philosophy

The goal is to make a social app that feels different from the current
generation of apps optimized for maximum engagement and dopamine loops.
Removing counters and share buttons removes the incentive to perform for
an audience or chase virality — posting becomes about the moment, not the
metrics.
