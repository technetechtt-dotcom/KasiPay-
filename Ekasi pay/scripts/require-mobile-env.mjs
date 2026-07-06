const apiUrl = (process.env.VITE_API_URL ?? '').trim();

if (!apiUrl) {
  console.error(
    '[mobile:build] Missing VITE_API_URL. Set it before running mobile builds (for example: https://api.example.com).',
  );
  process.exit(1);
}

try {
  const parsed = new URL(apiUrl);
  if (!parsed.protocol || !parsed.host) {
    throw new Error('invalid URL');
  }
} catch {
  console.error(
    `[mobile:build] Invalid VITE_API_URL "${apiUrl}". Provide a full absolute URL such as https://api.example.com.`,
  );
  process.exit(1);
}
