const secretPattern = /((?:authorization\s*:\s*)?bearer\s+|(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s]+@/gi;
/** The redaction rule for operational diagnostics: credential-shaped tokens and URL credentials are masked, and strings are bounded. */
/** Credential-shaped tokens and URL credentials masked, the text otherwise whole (GY-3150: a log tail is cut after masking, so a cut never splits a secret past the mask). */
export const maskSecrets = (value: string) => value.replace(secretPattern, (_match, label?: string, scheme?: string) => label ? `${label}[redacted]` : scheme ? `${scheme}[redacted]@` : '[redacted]');
export const redactString = (value: string) => maskSecrets(value).slice(0, 2000);
