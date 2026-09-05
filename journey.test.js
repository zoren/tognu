import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveJourneyKey,
  extractJourneys,
  mergeJourney,
  spanOfCalls,
} from './journey.js';

const fullJourney = {
  LineRef: 'B',
  DirectionRef: 1,
  FramedVehicleJourneyRef: { DataFrameRef: '2026-09-01', DatedVehicleJourneyRef: '622151-8602502600000' },
  DestinationName: 'Farum St.',
  TrainNumbers: { TrainNumberRef: 622151 },
  IsCompleteStopSequence: true,
  EstimatedCalls: {
    EstimatedCall: [
      { StopPointRef: 8600626, Order: 1, AimedDepartureTime: '2026-09-01T17:17:00+02:00', DeparturePlatformName: 5 },
      { StopPointRef: 8600645, Order: 2, AimedArrivalTime: '2026-09-01T17:18:00+02:00', AimedDepartureTime: '2026-09-01T17:18:00+02:00', DeparturePlatformName: 3 },
      { StopPointRef: 8600646, Order: 3, AimedArrivalTime: '2026-09-01T17:20:00+02:00', AimedDepartureTime: '2026-09-01T17:20:00+02:00', DeparturePlatformName: 3 },
    ],
  },
};

const delta = {
  LineRef: 'B',
  FramedVehicleJourneyRef: { DataFrameRef: '2026-09-01', DatedVehicleJourneyRef: '622151-8602502601000' },
  TrainNumbers: { TrainNumberRef: 622151 },
  IsCompleteStopSequence: false,
  EstimatedCalls: {
    EstimatedCall: [
      {
        StopPointRef: 8600645,
        AimedArrivalTime: '2026-09-01T17:18:00+02:00',
        ExpectedArrivalTime: '2026-09-01T17:21:00+02:00',
        AimedDepartureTime: '2026-09-01T17:18:00+02:00',
        ExpectedDepartureTime: '2026-09-01T17:21:00+02:00',
      },
    ],
  },
};

test('journey key is the operating day, same for full and delta versions', () => {
  const key = deriveJourneyKey(fullJourney, fullJourney.EstimatedCalls.EstimatedCall);
  assert.equal(key, '2026-09-01');
  assert.equal(deriveJourneyKey(delta, delta.EstimatedCalls.EstimatedCall), key);
});

test('journey key falls back to the first call date', () => {
  const j = { EstimatedCalls: { EstimatedCall: [{ AimedDepartureTime: '2026-09-01T17:17:00+02:00' }] } };
  assert.equal(deriveJourneyKey(j, j.EstimatedCalls.EstimatedCall), '2026-09-01');
});

test('complete message replaces prior state', () => {
  const merged = mergeJourney(delta, fullJourney);
  assert.equal(merged, fullJourney);
});

test('delta merges into the stored journey without losing calls', () => {
  const merged = mergeJourney(fullJourney, delta);
  const calls = merged.EstimatedCalls.EstimatedCall;
  assert.equal(calls.length, 3);
  assert.equal(calls[1].ExpectedDepartureTime, '2026-09-01T17:21:00+02:00');
  assert.equal(calls[1].DeparturePlatformName, 3);
  assert.equal(calls[2].AimedDepartureTime, '2026-09-01T17:20:00+02:00');
  assert.equal(merged.DestinationName, 'Farum St.');
  assert.equal(merged.IsCompleteStopSequence, true);
});

test('delta call for an unknown stop is inserted in aimed-time order', () => {
  const extra = {
    ...delta,
    EstimatedCalls: {
      EstimatedCall: [{ StopPointRef: 8600650, AimedArrivalTime: '2026-09-01T17:19:00+02:00' }],
    },
  };
  const calls = mergeJourney(fullJourney, extra).EstimatedCalls.EstimatedCall;
  assert.deepEqual(
    calls.map((c) => c.StopPointRef),
    [8600626, 8600645, 8600650, 8600646],
  );
});

test('delta with no stored journey is kept as-is', () => {
  assert.equal(mergeJourney(null, delta), delta);
});

test('span is normalized to UTC and spans the merged calls', () => {
  const { earliest, latest } = spanOfCalls(mergeJourney(fullJourney, delta).EstimatedCalls.EstimatedCall);
  assert.equal(earliest, '2026-09-01T15:17:00.000Z');
  assert.equal(latest, '2026-09-01T15:21:00.000Z');
});

test('extractJourneys handles single and repeated deliveries/frames', () => {
  const single = {
    Siri: {
      ServiceDelivery: {
        EstimatedTimetableDelivery: { EstimatedJourneyVersionFrame: { EstimatedVehicleJourney: [fullJourney] } },
      },
    },
  };
  assert.equal(extractJourneys(single).length, 1);
  const repeated = {
    Siri: {
      ServiceDelivery: {
        EstimatedTimetableDelivery: [
          { EstimatedJourneyVersionFrame: [{ EstimatedVehicleJourney: [fullJourney] }, { EstimatedVehicleJourney: [delta] }] },
          { EstimatedJourneyVersionFrame: { EstimatedVehicleJourney: [delta] } },
        ],
      },
    },
  };
  assert.equal(extractJourneys(repeated).length, 3);
  assert.equal(extractJourneys({}).length, 0);
});
