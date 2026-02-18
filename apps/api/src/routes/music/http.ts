export async function fetchJsonWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 4_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
