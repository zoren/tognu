// Pure helpers for interpreting Banedanmark's SIRI-ET journey messages.

export function callTime(c) {
  return (
    c.ExpectedDepartureTime ??
    c.ExpectedArrivalTime ??
    c.AimedDepartureTime ??
    c.AimedArrivalTime ??
    null
  );
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// EstimatedTimetableDelivery and EstimatedJourneyVersionFrame may repeat per
// the SIRI schema; EstimatedVehicleJourney is always an array via the parser.
export function extractJourneys(parsed) {
  const out = [];
  for (const delivery of asArray(parsed?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery)) {
    for (const frame of asArray(delivery?.EstimatedJourneyVersionFrame)) {
      out.push(...asArray(frame?.EstimatedVehicleJourney));
    }
  }
  return out;
}

// DatedVehicleJourneyRef embeds a version suffix that changes mid-journey, so
// key by operating day instead; (line, train_number) is unique within a day.
export function deriveJourneyKey(j, calls) {
  const day = j.FramedVehicleJourneyRef?.DataFrameRef ?? null;
  if (day) return String(day);
  const first = calls[0];
  const t = first?.AimedDepartureTime ?? first?.AimedArrivalTime ?? null;
  return t ? String(t).slice(0, 10) : '';
}

// Normalized to UTC ISO strings so they compare consistently with cutoffs
// regardless of the offset format the feed uses.
export function spanOfCalls(calls) {
  let earliest = null;
  let latest = null;
  for (const c of calls) {
    const t = callTime(c);
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) continue;
    if (earliest === null || ms < earliest) earliest = ms;
    if (latest === null || ms > latest) latest = ms;
  }
  return {
    earliest: earliest === null ? null : new Date(earliest).toISOString(),
    latest: latest === null ? null : new Date(latest).toISOString(),
  };
}

// A message with IsCompleteStopSequence=true carries the whole stop sequence
// and replaces prior state; anything else carries only the altered calls and
// must be merged into the journey we already know (SIRI-ET delta semantics).
export function mergeJourney(existing, incoming) {
  if (incoming.IsCompleteStopSequence === true || !existing) return incoming;
  const calls = [...(existing.EstimatedCalls?.EstimatedCall ?? [])];
  let appended = false;
  for (const ic of incoming.EstimatedCalls?.EstimatedCall ?? []) {
    const idx = calls.findIndex((c) => String(c.StopPointRef) === String(ic.StopPointRef));
    if (idx >= 0) calls[idx] = { ...calls[idx], ...ic };
    else {
      calls.push(ic);
      appended = true;
    }
  }
  if (appended) {
    calls.sort((a, b) => {
      const ta = Date.parse(a.AimedArrivalTime ?? a.AimedDepartureTime ?? callTime(a) ?? '') || 0;
      const tb = Date.parse(b.AimedArrivalTime ?? b.AimedDepartureTime ?? callTime(b) ?? '') || 0;
      return ta - tb;
    });
  }
  return {
    ...existing,
    ...incoming,
    EstimatedCalls: { EstimatedCall: calls },
    IsCompleteStopSequence: existing.IsCompleteStopSequence,
  };
}
