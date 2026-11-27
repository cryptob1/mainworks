export default `When a verified commit deploys, Mainworks pushes its \`vYYYY.M.D-<sha12>\` tag. GitHub Actions then publishes \`@cryptob1/graphyard\` with npm OIDC provenance, and both GHCR images (\`mainworks\`, \`mainworks-trial\`) with \`GITHUB_TOKEN\`; the host holds no publish token. Publishing runs apart from merge and deploy, and \`mainworks lead status\` shows npm's latest version.

One-time owner setup:

1. From your npm login, publish a \`@cryptob1/graphyard\` placeholder \`0.0.0\` with \`npm publish --access public\`.
2. In npm package settings, add a **Trusted Publisher**: GitHub Actions, **cryptob1/graphyard**, workflow **publish.yml**.
3. In each GHCR package (**mainworks**, **mainworks-trial**), grant **cryptob1/graphyard** Actions write access.`;
