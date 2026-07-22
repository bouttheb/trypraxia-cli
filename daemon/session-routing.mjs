export function sessionRouteCacheKey(session) {
  return `${session?.source || "unknown"}:${session?.sessionId || session?.evidence?.sessionFile || "unknown"}`;
}

export function shouldReuseSessionRoute(cached, routingKey, now, cacheMs) {
  if (!cached) return false;
  if (cached.locked) return true;
  return cached.routingKey === routingKey && now - cached.checkedAt < cacheMs;
}

export function lockSessionRoute(cache, key, route) {
  const current = cache.get(key);
  const locked = current === route ? current : route;
  locked.locked = true;
  cache.set(key, locked);
  return locked;
}
