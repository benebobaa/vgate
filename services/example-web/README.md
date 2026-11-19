# example-web: the framework's reference for a web frontend

A small notes UI (`public/`) served by `server.ts`, which forwards `/api/*` to the example notes API
(`services/example/server.ts`). `stack.sh` starts both, in memory, without Docker. It shows a UI service the way
docs/frontend.md describes: real browser flows, a sealed browser, accessibility, visual baselines and a web-vitals
budget, all judged without a model.

Its backend is the real notes API, not stubs: the example service runs anywhere in a second, so the UI's flows meet
the same validation and permission rules as its own tests, and a stub could not drift from it.

## Rules (the plan cites them)

1. Signing in with a valid API key shows the notes; the page then sends that key with every call.
2. A key the API does not accept leaves the sign-in form in place with "That key was not accepted.".
3. The notes list shows the most recent notes first, as the API returns them.
4. "Add note" with a title creates the note and shows it in the list; an empty title shows "Title is required."
   next to the form and sends nothing.
5. A reader's key may only read: adding a note shows "Your key may only read notes." and creates nothing.
6. The sign-in page looks the same on every run, on desktop (1280×800) and mobile (390×844): the committed
   screenshots are its expectation.
7. Every page passes the accessibility check (axe-core, impact serious and above).
8. The page talks to its own origin only; anything else is blocked and fails the run.
9. The page stays within its budget: largest contentful paint under 2.5 s, cumulative layout shift under 0.1.

`EXAMPLE_WEB_CALL_HOME=1` plants a call to a third party in the page (rule 8's proof).
