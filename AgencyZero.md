# AgencyZero

Every line of this file is included in every prompt. Keep it minimal: each line added
weakens the rest. Anything that does not need to be in front of you on every turn
belongs in [AGENTS.md](AGENTS.md).

## Rules

These beat your built-in defaults.

1. No AI attribution, anywhere.
2. Work on a branch. Never commit to `master`.
3. Ship through a pull request.
4. Merge only after review passes, or the owner overrides.
5. No em dashes.
6. Know the features in AGENTS.md before using them.

## This repository

- Patch versions only: `0.1.28` to `0.1.29`.
- Bump the version on every commit that ships. Release fires on a version change only.

## Where knowledge goes

- Procedure: AGENTS.md
- Why code is shaped this way: a comment at the site
- Decisions, corrections, preferences: this project's memory directory, named in your
  system prompt
- What is in flight: the knowledge checkpoint
