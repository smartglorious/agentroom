# Contributing to AgentRoom

Thank you for helping improve AgentRoom.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep each change focused and avoid unrelated formatting edits.
3. Do not commit credentials, tokens, generated packages, `.vsix` files, or `.zip` archives.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npx tsc --noEmit -p .
npm test
```

All three commands must pass before a pull request is ready for review. Add or update tests for behavior changes and update the README and CHANGELOG when user-facing behavior changes.

## Pull requests

- Explain the problem and the chosen solution.
- Link related issues.
- Describe how the change was tested.
- Keep private or product-specific integrations out of the public core.
- By contributing, you agree that your contribution is licensed under the MIT License.
