# AGENTS-MEMORY

## Common Task Rules

- Add project descriptions, operating principles, and supporting rationale to the appropriate README language files.
- Use polite Korean for interactions with Korean-speaking users.
- If `AGENTS.local.md` exists in the project root, its rules take precedence over this file.
- Ask rather than guess when a user request is ambiguous.

## Language and Localization

- The product targets a global audience. English is the default language for product behavior, source-facing text, command help, logs, errors, generated content, and documentation.
- All script, CLI, daemon, service, MCP, hook, and API-generated human-readable output MUST be English.
- When documentation can be split cleanly, maintain separate complete English and Korean files. The default/canonical file MUST be English, and both language versions MUST link to each other.
- When documentation cannot be split, include both English and Korean in the same file, with English first.
- Keep the English and Korean documentation semantically synchronized whenever either version changes.

## Git Commit Rules

- Do not include Co-Authored-By trailers in commits.
- Write commit messages in Korean.
- Split changes that contain multiple features or tasks into small, focused commits.

## Documentation Rules

- Write task documentation under `docs/`, except canonical repository files such as `README.md`, localized README variants, and agent instruction files.
- Put documents that must not be tracked by Git, or that the user explicitly requests not to track, under `docs/memo/`.
