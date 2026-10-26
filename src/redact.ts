export const MAX_ERROR_DETAIL_CHARS = 300;

/**
 * Removes credentials before an error reason is shown or persisted. Provider
 * messages occasionally echo the Authorization header or an API key.
 */
export function sanitizeErrorDetail(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_DETAIL_CHARS)
    .trimEnd();
}

function readMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Extracts the human-readable reason from an SDK or gateway error. Response
 * bodies take precedence over the SDK's generic `message`, because gateways
 * such as `当前集群负载较高` only appear in the body.
 */
export function getClassifierErrorDetail(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return sanitizeErrorDetail(error) || undefined;
  }

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { message?: unknown; error?: unknown };
  const body = candidate.error;
  let bodyMessage = readMessage(body);

  if (typeof body === 'object' && body !== null) {
    const nested = (body as { error?: unknown }).error;
    if (typeof nested === 'object' && nested !== null) {
      bodyMessage ??= readMessage((nested as { message?: unknown }).message);
    }
    bodyMessage ??= readMessage((body as { message?: unknown }).message);
  }

  const message = bodyMessage ?? readMessage(candidate.message);
  if (!message) {
    return undefined;
  }

  return sanitizeErrorDetail(message) || undefined;
}
