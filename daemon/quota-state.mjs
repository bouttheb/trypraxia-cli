// Real per-agent subscription quota state for the heartbeat.
//
// The execution router turns each agent's `remainingRatio` into a shadow cost:
// as a subscription looks scarce, the router steers work away from it. The old
// signal was faked — `remainingRatio: 0.05` whenever the agent had ANY command
// in flight — so a subscription that is merely BUSY looked nearly exhausted and
// the router fled it, leaving paid bandwidth (e.g. a Claude Max plan) unused.
//
// The honest signal: an agent is only "exhausted" when a command actually hit
// its plan's usage limit and is being held until the plan's usage window
// resets. That is exactly what the daemon's quota-retry queue records
// (`reason: "quota"` with a `retryAt`). Everything else reads as fully
// available, so the router uses the subscription up to its real cap and only
// then falls back. Auth holds (`reason: "auth"`) are a login problem, not a
// quota problem, and never count as exhaustion here.
export function computeQuotaState(agents, quotaRetryQueue = []) {
  const holds = {};
  for (const entry of quotaRetryQueue) {
    if (!entry || entry.reason !== "quota" || !entry.agent) continue;
    const hold = holds[entry.agent] || (holds[entry.agent] = { heldCommands: 0, resetAt: null });
    hold.heldCommands += 1;
    const retryAt = typeof entry.retryAt === "number" ? entry.retryAt : null;
    if (retryAt != null && (hold.resetAt == null || retryAt < hold.resetAt)) hold.resetAt = retryAt;
  }
  const state = {};
  for (const agent of agents) {
    const hold = holds[agent];
    state[agent] = hold
      ? { remainingRatio: 0, exhausted: true, resetAt: hold.resetAt, heldCommands: hold.heldCommands }
      : { remainingRatio: 1, exhausted: false, heldCommands: 0 };
  }
  return state;
}
