# Feedback log

Running backlog of bugs, bad outputs, and UX friction found while using the app.
Drop one-liners here as you hit them — doesn't need to be polished. Claude reads
this at the start of a work session, groups by theme, and ships fixes in batches.

## How to log an item

Copy one of the templates below, fill the blanks, leave it under **Open**.
When it's shipped, Claude moves it to **Done** with the commit SHA.

### Templates

**Broken** — something errored or behaved wrong
```
- [BROKEN] <page or feature>: <what happened>
  url: <path>
  steps: <what you did>
  expected: <what should have happened>
  screenshot/log: <paste or path>
```

**Wrong output** — a draft, signal, summary, etc. reads poorly
```
- [OUTPUT] <where>: <one-line verdict>
  input: <account / contact / signal id + what you clicked>
  got:
  > <paste the actual bad output>
  want:
  > <what you wish it said — even a sketch helps>
  why it's wrong: <tone / factual / missing context / etc.>
```

**UX** — confusing, hard to find, friction
```
- [UX] <page>: <what's confusing>
  url: <path>
  what you tried: <...>
  what you expected: <...>
```

**Feature** — missing capability
```
- [FEATURE] <one-line ask>
  scenario: <when you'd use it>
  today's workaround: <what you do instead>
```

---

## Open

<!-- Add new items here. Newest on top is fine. -->



---

## Done

<!-- Claude moves items here with the commit SHA when shipped. Format:
- [TYPE] <item> — fixed in <sha> (<date>)
-->



---

## Not doing

<!-- Items intentionally closed without a fix. Record the reason so we don't
re-litigate. Format:
- [TYPE] <item> — wontfix: <reason>
-->

