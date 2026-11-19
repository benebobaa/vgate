# Test strength (`vgate mutate`)

Coverage tells you a line ran during the tests. It does not tell you a test would notice that line going wrong. An
agent can write tests that call everything and assert little: coverage looks perfect, and a bug merges anyway.

`vgate mutate` measures what coverage cannot. It plants one small bug at a time in the lines a pull request changed,
rebuilds and restarts the app, and runs the service's own tests against it:

- a test that passed before now fails: the bug was **caught** (killed);
- every test still passes: the bug **survived**, and the report says which scenario would have caught it.

**Score** = caught / (caught + survived), over the changed code only.

```bash
vgate mutate --service orders --base origin/main             # budget and time limit from vgate.yaml
vgate mutate --service orders --base origin/main --budget 30 --timeout 15m
```

```
MUTATION OK orders: the tests caught 7 of 10 planted bugs in the changed code (70%)
killed      app/orders.ts:104 equality  typeof amount !== 'number'  ->  typeof amount === 'number'  [ORD-402-MAIL]
survived    app/orders.ts:104 boundary  ... amount < 1 ...  ->  ... amount <= 1 ...
HINT no test noticed when `<` became `<=` in app/orders.ts:104: add a scenario at the exact limit value
```

## What it plants

The classic bugs that survive weak test suites, in the code of the changed lines only. Comments, strings and regular
expressions are never touched, except that the last operator empties a string a function returns.

| Operator        | Change                                                                          |
| --------------- | ------------------------------------------------------------------------------- |
| `boundary`      | `<` ↔ `<=`, `>` ↔ `>=` (only with spaces around it, so `List<T>` and `=>` stay) |
| `equality`      | `==` ↔ `!=`, `===` ↔ `!==`                                                      |
| `logical`       | `&&` ↔ `\|\|` (Python: `and` ↔ `or`)                                            |
| `boolean`       | `true` ↔ `false` (Python: `True` ↔ `False`)                                     |
| `arithmetic`    | binary `+` ↔ `-` (with spaces around it)                                        |
| `negation`      | drop a unary `!` (Python: drop `not `)                                          |
| `number`        | a numeric literal n → n + 1                                                     |
| `return-string` | the string a `return` gives back → empty                                        |

Languages, by file extension: TypeScript and JavaScript, Go, Java, Kotlin, Scala, C#, Swift, Rust, Dart, C and C++,
and Python. Each file is read by a small scanner for its language family (comments, nested block comments where the
language nests them, strings, Go raw strings, text blocks and triple quotes, Rust, C# and C++ raw and multi-line
strings, JavaScript templates and regular expressions, Python triple quotes), not by regular expressions on raw text.

**Which files.** The changed files with those extensions are the candidates. These are left out:

- symbolic links (a mutant written through one could land outside the scratch copy);
- tests by name, in each language's conventions;
- generated and vendored code, and build output;
- documentation;
- the service's migrations;
- the service's verification folder (`tests/`, `support/`, `deps/`).

With `paths:` in service.yaml, only files those globs name count. A file directly in the service's folder counts only
when `paths:` names it.

**Which mutants.** Every candidate gets a deterministic id. When there are more than `--budget`, vgate samples them in
a fixed order: spread across the files, then across the lines within each file. The same change always gets the same
sample.

## How it runs

1. **A scratch copy.** A git worktree at HEAD, plus your uncommitted changes and untracked files. Your tree, your
   running stack and your reports are never touched.
2. **The unmutated code first.** The app starts the way the service runs it, and the service's API tests run once.
   Only a test that passes here can catch a mutant. A test already failing (a known failure, a broken scenario) is set
   aside per test, not per scenario id, so one failing case of a table never hides the others.
3. **Each mutant in turn.**
   - It is applied to the scratch copy, and the app is rebuilt and restarted.
     - Declared environment with a built app: only the app image is rebuilt and recreated; the dependencies keep
       running.
     - Declared environment otherwise: the whole environment restarts.
     - `stack.sh`: down, then up.
   - The tests run, stopping at the first failure when nothing failed before.
   - The file is then restored.
4. **Outcome of each mutant:**

   | Outcome     | When                                                                                                                          | Counts in the score?                |
   | ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
   | killed      | a test that passed before fails                                                                                               | yes                                 |
   | killed      | the app does not come up with the mutant, and does again without it (declared environment with a built app)                   | yes (any test would notice)         |
   | build-error | the app does not come up with the mutant (`stack.sh`, or an app without a build: a build failure cannot be told from a crash) | no                                  |
   | survived    | every test passes                                                                                                             | yes                                 |
   | timeout     | the tests run past 3× the unmutated run time, plus 30 s                                                                       | no, reported apart                  |
   | build-error | the mutant does not build (compiled languages)                                                                                | no: it says nothing about the tests |
   | not-run     | `--timeout` was reached first, or the app stopped coming up even without a mutant                                             | no, reported                        |

5. **Clean-up.** The environment, the mutant images and the scratch worktree are removed.

Only the API tests run. The fault tests pause containers and are slow.

**Cost.** Each mutant costs a rebuild, a restart and one test run. On the reference `example-orders`, a sealed
environment with PostgreSQL, Redis, Kafka and stubs, that is about 10 seconds per mutant: 10 mutants in 104 s. Keep
the budget small on pull requests, and run a larger one on a schedule if you want a fuller picture.

## The report and the decision

`reports/mutation.json` (`vgate.mutation/1`) holds:

- the score and the counts;
- every mutant with its file, line, change, outcome and the tests that caught it;
- for each survivor, a hint.

It is bound to the commit and merge base, like a gate verdict.

```yaml
# vgate.yaml
policy:
  autoMerge: low
  mutationScore: 0.7 # 70% of the bugs planted in the changed code must be caught
mutation:
  budget: 20 # mutants per run
  timeout: 10m # per run
```

With `policy.mutationScore` set, `vgate decide` checks each affected service whose source code the change touches.
The pull request **needs a human** when the service's test strength is:

- **below the threshold**, with the survivors listed in the comment;
- **unmeasured**: no mutant could be judged;
- **missing**: no current evidence (none at all, another merge base, or another commit).

It never blocks. Mutation measures the tests, not the code's correctness: a person decides whether to add the missing
scenarios or accept the gap. Without the policy, a score that was measured is shown in the comment for information.

A change that touches no source code vgate mutates (docs, tests only, configuration) is not applicable and needs
nothing.

## In CI

In the gate job, after `vgate gate`, on pull requests and merge queues (they have a base to compare with):

```bash
vgate mutate --service "$SERVICE" --base "$BASE"   # writes reports/mutation.json
```

Collect `mutation.json` with the verdict as evidence. The GitHub workflow and GitLab component will run it when
`policy.mutationScore` is set.

## Limits

- **The operators are textual.**
  - A mutant can be equivalent: a change that cannot alter behaviour. It survives, and no test could kill it.
  - In a dynamic language a mutant can fail only at run time; it then counts as killed, as any test would notice.
- **Spacing matters.** The boundary and arithmetic operators need spaces around the operator. Code formatted without
  them is mutated less.
- **Everything runs per mutant.** Each mutant runs the whole API test suite, not only the tests of the changed
  operation. Stopping at the first failure keeps killed mutants fast; survivors take a full run.
