// Where "Sign in with GitHub" goes. Fill these in after registering the GitHub App and
// deploying the relay (README → "Setting up Sign in with GitHub"); while they are empty the
// page offers only personal access tokens.
export const GITHUB_APP = {
  // the app's "Client ID" (public)
  clientId: 'Iv23liYmOPookZ1BEEfi',
  // the app's URL name: github.com/apps/<slug>
  slug: 'markdown-github-editor',
  // the deployed worker/relay.js, e.g. https://meditor-auth.<account>.workers.dev
  relay: 'https://meditor-auth.ondra-lengal.workers.dev',
};
