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

- No like **counts** — only the post's own author ever sees how many likes
  it has.
- No share button, at all.

## What IS included, despite the above

There **is** a like button and a comment button. Likes stay private: you can
like a post, but only its author sees "24 likes" — nobody else does. Comments
are different, and visible to everyone: a comment count sits on the comment
button itself, since anyone who can open the thread could already count the
replies in it by scrolling — the badge just saves the scroll, it doesn't
expose anything new.

Friend counts follow the same private rule as likes. Opening someone else's
profile — from search, a friend request, or a friends list — shows only
their avatar, username, and post count. Their friend count is never shown to
anyone but the account owner themself, viewing their own profile.

## Philosophy

The goal is to make a social app that feels different from the current
generation of apps optimized for maximum engagement and dopamine loops.
Removing counters and share buttons removes the incentive to perform for
an audience or chase virality — posting becomes about the moment, not the
metrics.
