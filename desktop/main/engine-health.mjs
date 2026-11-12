export async function waitForEngineHealth({
  request,
  active,
  signal,
  log,
  timeoutMs = 120_000,
  intervalMs = 300,
}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastFailure = 'none';
  while (Date.now() < deadline && active() && !signal.aborted) {
    try {
      const response = await request();
      if (response.ok && (await response.json()).ok === true) return true;
      lastFailure = response.ok ? 'unexpected response' : `HTTP ${response.status}`;
    } catch (error) {
      lastFailure =
        [error?.cause?.code, error?.code].find((code) => typeof code === 'string') ||
        error?.name ||
        'error';
    }
    await new Promise((accept) => setTimeout(accept, intervalMs));
  }
  if (Date.now() >= deadline && !signal.aborted) {
    const waited = ((Date.now() - started) / 1000).toFixed(1);
    await log(
      `Background service health check timed out after ${waited}s. Engine process still running: ${active() ? 'yes' : 'no'}. Last health check: ${lastFailure}.`,
    );
  }
  return false;
}
