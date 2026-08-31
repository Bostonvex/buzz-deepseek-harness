# Contributing

Thanks for helping improve Buzz DeepSeek Harness.

## Development

1. Fork the repository and create a focused branch.
2. Install the locked dependencies with `npm ci --ignore-scripts`.
3. Make the smallest change that solves the issue.
4. Run the required checks:

   ```sh
   npm test
   npm run schema:audit
   ```

5. Open a pull request describing the behavior change and verification.

Do not include API keys, Buzz private keys, auth tags, local model credentials,
or application configuration in issues, fixtures, logs, or pull requests.
Live smoke tests are optional for contributors because they require a local
model endpoint and, for MCP checks, a local Buzz installation.

## Maintainer policy

Only the repository maintainer has direct write access. External contributions
must arrive as pull requests and are not merged until the required CI checks
pass.
