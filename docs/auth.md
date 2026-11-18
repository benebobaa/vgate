# Authentication

Every seeded user in `service.yaml` (`environments.<env>.users`) becomes request headers. Which headers depends on
what the user carries and what the environment configures:

| The user has | The environment has | The framework sends                                            |
| ------------ | ------------------- | -------------------------------------------------------------- |
| `token`      | `auth.header`       | `<header>: <scheme> <token>` (default `Authorization: Bearer`) |
| `password`   | `auth.session`      | The cookies its login set, and the CSRF header when configured |
| `password`   | `keycloak`          | `Authorization: Bearer <access token>` (password grant)        |
| neither      |                     | nothing (anonymous)                                            |

One environment can mix them: an LLM gateway's API keys (`token`) next to its console accounts (`password` with a
session). When both `auth.session` and `keycloak` are set, password users log in through the session.

## Session logins (console-style APIs)

```yaml
environments:
  local:
    origin: http://localhost:3001 # sent on the login and on every call: Origin-checking CSRF guards see a browser
    auth:
      header: Authorization # API keys, for the users that have a token
      scheme: Bearer
      session:
        login:
          method: POST # default
          path: /api/v1/auth/login
          body: { email: '{username}', password: '{password}' } # any JSON; both placeholders are replaced
          headers: {} # optional, e.g. a captcha test token
        cookie: llmrouter_session # the cookie the login must set
        csrf: # optional
          cookie: csrf_token # read the token from a cookie the login set...
          field: data.csrfToken # ...or from a field of the login answer (dot path)
          header: X-CSRF-Token # and send it on every call
    users:
      owner: { username: owner@example.com, password: '${OWNER_PASSWORD}', role: owner }
      member: { username: member@example.com, password: '${MEMBER_PASSWORD}', role: member }
      ci: { token: '${CI_API_KEY}', role: api key }
```

- `username` is the login name when it differs from the user's key (an email address); default the key.
- Each worker logs a user in once and reuses the session. A login that does not answer 2xx, or answers without the
  configured cookie or CSRF token, fails the test with the user, the operation and the answer named.
- Every cookie the login set travels back, as a browser would send it (a double-submit CSRF cookie included).
- A test that ends or revokes a session (logout, password change, "revoke other sessions") must take its own:
  `api.as('owner', { newSession: true })`. Otherwise it would log out every other test of its worker.
- A session the test obtained itself: `api.asSession(cookieValue, csrfToken?)`. Accounts created during the run:
  `api.asCredentials({ username, password })` logs them in the same way.

### Schemathesis

`task contract` runs once per user of `schemathesis.users`. A session user's cookie is passed through the contract's
cookie security scheme (`type: apiKey, in: cookie, name: <cookie>`) in a generated `schemathesis.toml`, so
Schemathesis can also leave it out and check that the call is refused. A contract without such a scheme gets a raw
`Cookie` header instead; Schemathesis then reports a call it expected to be refused as accepted (ST201) for
operations that need the session. Document the cookie in the contract's `securitySchemes` to avoid that.

`task token -- <user>` prints the `Cookie` header value of a session user.
