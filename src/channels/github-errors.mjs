/** Transport facts only. Response bodies and credential-bearing diagnostics never escape. */
export class GitHubRequestError extends Error {
  constructor(status, { message, scope } = {}) {
    const statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const category = statusCode === 401 ? 'auth' : statusCode === 410 ? 'gone'
      : statusCode === 403 && scope !== 'repository' && typeof message === 'string' && /\blocked\b/i.test(message) ? 'locked'
      : statusCode === 403 ? 'forbidden' : statusCode === 404 ? 'not-found'
      : statusCode === 429 ? 'rate-limit' : statusCode >= 500 ? 'server' : 'transport';
    super(`GitHub API request failed${statusCode ? ` (HTTP ${statusCode})` : ''}`);
    this.name = 'GitHubRequestError'; this.category = category;
    if (statusCode) this.status = this.statusCode = statusCode;
    if (scope) this.scope = scope;
  }
}

export function classifyGitHubError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(error?.status) ? error.status : undefined;
  const native = error instanceof GitHubRequestError ? error.category : undefined;
  const category = native ?? (statusCode === 401 ? 'auth' : statusCode === 410 ? 'gone'
    : statusCode === 403 ? 'forbidden' : statusCode === 404 ? 'not-found' : statusCode === 429 ? 'rate-limit'
    : statusCode >= 500 ? 'server' : error?.githubScope === 'repository' ? 'identity' : error?.scope === 'repository' ? 'configuration' : 'invalid');
  return { category, ...(statusCode ? { statusCode } : {}), message: {
    auth: 'GitHub authentication failed', gone: 'GitHub target was deleted', locked: 'GitHub discussion is locked',
    forbidden: 'GitHub access is forbidden', 'not-found': 'GitHub object is unavailable', 'rate-limit': 'GitHub rate limit reached',
    server: 'GitHub service is unavailable', transport: 'GitHub transport failed', identity: 'GitHub repository identity mismatch',
    invalid: 'GitHub response could not be validated', configuration: 'GitHub repository authentication configuration is unavailable',
  }[category] };
}

export function githubRepositoryFailure(error) {
  return error?.scope === 'repository' || error?.githubScope === 'repository' || classifyGitHubError(error).category === 'auth';
}

export function githubIdentityError(message) {
  const error = new Error(message); error.githubScope = 'repository'; return error;
}
