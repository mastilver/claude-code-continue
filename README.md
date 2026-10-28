# auto-continue

A Claude Code mod that resumes your session after a usage limit resets.

When a turn stops on a usage limit, the mod reads the reset time from the session's rate-limit data, or from the "resets 3pm (Europe/London)" text if that data is missing. It shows a countdown in the status line, and 90 seconds after the reset it sends `continue` into the same session. A short-lived 429 with no reset time is ignored.

- Typing a prompt yourself cancels the pending continue.
- If the limit is hit again straight after resuming, it retries every 5 minutes, up to 3 times.
- The pending continue is saved, so it survives a mod reload or restart of the same session. It is dropped after `/clear` or in a different session.
- `/auto-continue` shows what is pending; `/auto-continue cancel` stops it.

The session must stay open and the machine awake; nothing runs while Claude Code is closed.

Requires Claude Code 2.1.312 or later (the version it was built and tested on).

## Install

At the Claude Code prompt:

```
/plugin install auto-continue --marketplace mastilver/claude-code-continue
```

Answer `y` to add the marketplace, then pick a scope (user scope enables it in every session).

## Develop

Run a local checkout instead of the published version:

```sh
claude --plugin-dir /path/to/claude-code-continue
```

Checks:

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # after the mod has loaded once, which writes .claude-plugin/types/
```
