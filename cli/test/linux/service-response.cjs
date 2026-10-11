module.exports = async function serviceResponse(version) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:5811', {
        signal: AbortSignal.timeout(500),
      });
      const body = await response.json();
      if (response.ok && body.version === version) return body;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP service did not reach version ${version}`);
};
