// Shared JSON response helper for the team relay routes. No onRequest export → Pages does not route it.
export function json(obj, status, robots = 'noindex') {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': robots },
  });
}
