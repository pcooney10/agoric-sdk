// @ts-check
import {
  ExplicitBucketHistogramAggregation,
  MeterProvider,
  View,
} from '@opentelemetry/sdk-metrics';

import { makeLegacyMap } from '@agoric/store';

import {
  KERNEL_STATS_SUM_METRICS,
  KERNEL_STATS_UPDOWN_METRICS,
} from '@agoric/swingset-vat/src/kernel/metrics.js';

// import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.VERBOSE);

/** @typedef {import('@opentelemetry/api-metrics').MetricAttributes} Attributes */
/** @typedef {import('@opentelemetry/api-metrics').Histogram} Histogram */

import { getTelemetryProviders as getTelemetryProvidersOriginal } from '@agoric/telemetry';

/**
 * TODO Would be nice somehow to label the vats individually, but it's too
 * high cardinality for us unless we can somehow limit the number of active
 * metrics (many more than 20 vats).
 */
const VAT_ID_IS_TOO_HIGH_CARDINALITY = true;

export const HISTOGRAM_MS_LATENCY_BOUNDARIES = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  Infinity,
];
export const HISTOGRAM_SECONDS_LATENCY_BOUNDARIES =
  HISTOGRAM_MS_LATENCY_BOUNDARIES.map(ms => ms / 1000);

const baseMetricOptions = /** @type {const} */ ({
  swingset_crank_processing_time: {
    description: 'Processing time per crank (ms)',
    boundaries: [1, 11, 21, 31, 41, 51, 61, 71, 81, 91, Infinity],
  },
  swingset_block_processing_seconds: {
    description: 'Processing time per block',
    boundaries: HISTOGRAM_SECONDS_LATENCY_BOUNDARIES,
  },
  swingset_vat_startup: {
    description: 'Vat startup time (ms)',
    boundaries: HISTOGRAM_MS_LATENCY_BOUNDARIES,
  },
  swingset_vat_delivery: {
    description: 'Vat delivery time (ms)',
    boundaries: HISTOGRAM_MS_LATENCY_BOUNDARIES,
  },
  swingset_meter_usage: {
    description: 'Vat meter usage',
    boundaries: HISTOGRAM_MS_LATENCY_BOUNDARIES,
  },
});

const wrapDeltaMS = (finisher, useDeltaMS) => {
  const startMS = Date.now();
  return (...finishArgs) => {
    try {
      return finisher(...finishArgs);
    } finally {
      const deltaMS = Date.now() - startMS;
      useDeltaMS(deltaMS, finishArgs);
    }
  };
};

const recordToKey = record =>
  JSON.stringify(
    Object.entries(record).sort(([ka], [kb]) => (ka < kb ? -1 : 1)),
  );

export function getMetricsProviderViews() {
  return Object.entries(baseMetricOptions).map(
    ([instrumentName, { boundaries }]) =>
      new View({
        aggregation: new ExplicitBucketHistogramAggregation([...boundaries]),
        instrumentName,
      }),
  );
}

export function makeDefaultMeterProvider() {
  return new MeterProvider({ views: getMetricsProviderViews() });
}

/** @param {Omit<NonNullable<Parameters<typeof getTelemetryProvidersOriginal>[0]>, 'views'>} [powers] */
export function getTelemetryProviders(powers = {}) {
  return getTelemetryProvidersOriginal({
    ...powers,
    views: getMetricsProviderViews(),
  });
}

/**
 *
 * @param {import('@opentelemetry/api-metrics').Meter} metricMeter
 * @param {string} name
 */
function createHistogram(metricMeter, name) {
  const { description } = baseMetricOptions[name] || {};
  return metricMeter.createHistogram(name, { description });
}

/**
 * @param {{
 *   metricMeter: import('@opentelemetry/api-metrics').Meter,
 *   attributes?: import('@opentelemetry/api-metrics').MetricAttributes,
 * }} param0
 */
export function makeSlogCallbacks({ metricMeter, attributes = {} }) {
  // Legacy because legacyMaps are not passable
  const groupToRecorder = makeLegacyMap('metricGroup');

  /**
   * This function reuses or creates per-group named metrics.
   *
   * @param {string} name name of the base metric
   * @param {Attributes} [group] the
   * attributes to associate with a group
   * @param {Attributes} [instance] the specific metric attributes
   * @returns {Pick<Histogram, 'record'>} the attribute-aware recorder
   */
  const getGroupedRecorder = (name, group = undefined, instance = {}) => {
    let nameToRecorder;
    const groupKey = group && recordToKey(group);
    const instanceKey = recordToKey(instance);
    if (groupToRecorder.has(groupKey)) {
      let oldInstanceKey;
      [nameToRecorder, oldInstanceKey] = groupToRecorder.get(groupKey);
      if (group) {
        if (instanceKey !== oldInstanceKey) {
          for (const metric of nameToRecorder.values()) {
            // FIXME: Delete all the metrics of the old instance.
            metric;
          }
          // Refresh the metric group.
          // Legacy because Metric thing does not seem to be a passable
          nameToRecorder = makeLegacyMap('metricName');
          groupToRecorder.set(groupKey, [nameToRecorder, instanceKey]);
        }
      }
    } else {
      // Legacy because Metric thing does not seem to be a passable
      nameToRecorder = makeLegacyMap('metricName');
      groupToRecorder.init(groupKey, [nameToRecorder, instanceKey]);
    }

    /** @type {Histogram} */
    let recorder;
    if (nameToRecorder.has(name)) {
      recorder = nameToRecorder.get(name);
    } else {
      // Bind the base metric to the group and instance attributes.
      const metric = createHistogram(metricMeter, name);
      // Create a value recorder with the specfic attributes.
      recorder = harden({
        record: (value, attrs) =>
          metric.record(value, {
            ...attributes,
            ...group,
            ...instance,
            ...attrs,
          }),
      });
      nameToRecorder.init(name, recorder);
    }
    return recorder;
  };

  /**
   * Return the vat metric group that should be reset when the stats change.
   *
   * @param {string} vatID
   * @returns {Record<string,string> | undefined}
   */
  const getVatGroup = vatID => {
    if (VAT_ID_IS_TOO_HIGH_CARDINALITY) {
      return undefined;
    }
    return { vatID };
  };

  /**
   * Measure some interesting stats.  We currently do a per-vat recording of
   * time spent in the vat for startup and delivery.
   */
  const slogCallbacks = {
    startup(_method, [vatID], finisher) {
      return wrapDeltaMS(finisher, deltaMS => {
        const group = getVatGroup(vatID);
        getGroupedRecorder('swingset_vat_startup', group).record(deltaMS);
      });
    },
    delivery(_method, [vatID], finisher) {
      return wrapDeltaMS(
        finisher,
        (deltaMS, [[_status, _problem, meterUsage]]) => {
          const group = getVatGroup(vatID);
          getGroupedRecorder('swingset_vat_delivery', group).record(deltaMS);
          if (meterUsage) {
            // Add to aggregated metering stats.
            for (const [key, value] of Object.entries(meterUsage)) {
              if (key === 'meterType') {
                continue;
              }
              getGroupedRecorder(`swingset_meter_usage`, group, {
                // The meterType is an instance-specific attribute--a change in
                // it will result in the old value being discarded.
                ...(meterUsage.meterType && {
                  meterType: meterUsage.meterType,
                }),
                stat: key,
              }).record(value || 0);
            }
          }
        },
      );
    },
  };

  return harden(slogCallbacks);
}

/**
 * Create a metrics manager for the 'inboundQueue' structure, which
 * can be scaped to report current length, and the number of
 * increments and decrements. This must be created with the initial
 * length as extracted from durable storage, but after that we assume
 * that we're told about every up and down, so our RAM-backed shadow
 * 'length' will remain accurate.
 *
 * Note that the add/remove counts will get reset at restart, but
 * Prometheus/etc tools can tolerate that just fine.
 *
 * @param {number} initialLength
 */
export function makeInboundQueueMetrics(initialLength) {
  let length = initialLength;
  let add = 0;
  let remove = 0;

  return harden({
    incStat: (delta = 1) => {
      length += delta;
      add += delta;
    },

    decStat: (delta = 1) => {
      length -= delta;
      remove += delta;
    },

    getStats: () => ({
      cosmic_swingset_inbound_queue_length: length,
      cosmic_swingset_inbound_queue_add: add,
      cosmic_swingset_inbound_queue_remove: remove,
    }),
  });
}

/**
 * @param {object} param0
 * @param {any} param0.controller
 * @param {import('@opentelemetry/api-metrics').Meter} param0.metricMeter
 * @param {Console} param0.log
 * @param {Attributes} [param0.attributes]
 * @param {any} [param0.inboundQueueMetrics]
 */
export function exportKernelStats({
  controller,
  metricMeter,
  log = console,
  attributes = {},
  inboundQueueMetrics,
}) {
  const kernelStatsMetrics = new Map();
  const expectedKernelStats = new Set();

  function warnUnexpectedKernelStat(key) {
    if (!expectedKernelStats.has(key)) {
      log.warn(`Unexpected SwingSet kernel statistic`, key);
      expectedKernelStats.add(key);
    }
  }

  let kernelStatsLast = 0;
  let kernelStatsCache = {};
  const getKernelStats = () => {
    const now = Date.now();
    if (now - kernelStatsLast < 800) {
      return kernelStatsCache;
    }
    kernelStatsLast = now;
    kernelStatsCache = controller.getStats();
    Object.keys(kernelStatsCache).forEach(key => {
      warnUnexpectedKernelStat(key);
    });
    return kernelStatsCache;
  };

  KERNEL_STATS_SUM_METRICS.forEach(({ key, name, ...options }) => {
    expectedKernelStats.add(key);
    const counter = metricMeter.createObservableCounter(name, options);
    counter.addCallback(observableResult => {
      observableResult.observe(getKernelStats()[key], attributes);
    });
    kernelStatsMetrics.set(key, counter);
  });

  KERNEL_STATS_UPDOWN_METRICS.forEach(({ key, name, ...options }) => {
    expectedKernelStats.add(key);
    expectedKernelStats.add(`${key}Up`);
    expectedKernelStats.add(`${key}Down`);
    expectedKernelStats.add(`${key}Max`);
    const counter = metricMeter.createObservableUpDownCounter(name, options);
    counter.addCallback(observableResult => {
      observableResult.observe(getKernelStats()[key], attributes);
    });
    kernelStatsMetrics.set(key, counter);
  });

  if (inboundQueueMetrics) {
    for (const name of ['length', 'add', 'remove']) {
      const key = `cosmic_swingset_inbound_queue_${name}`;
      expectedKernelStats.add(key);
      const counter = metricMeter.createObservableCounter(key, {
        description: `inbound queue ${name}`,
      });
      counter.addCallback(observableResult => {
        observableResult.observe(
          inboundQueueMetrics.getStats()[key],
          attributes,
        );
      });
      kernelStatsMetrics.set(key, counter);
    }
  }

  function checkKernelStats(stats) {
    const notYetFoundKernelStats = new Set(kernelStatsMetrics.keys());
    Object.keys(stats).forEach(key => {
      notYetFoundKernelStats.delete(key);
      warnUnexpectedKernelStat(key);
    });
    notYetFoundKernelStats.forEach(key => {
      log.warn(`Expected SwingSet kernel statistic`, key, `not found`);
    });
  }

  // We check everything on initialization.  Other checks happen when scraping.
  checkKernelStats(controller.getStats());

  const [schedulerCrankTimeHistogram, schedulerBlockTimeHistogram] = [
    'swingset_crank_processing_time',
    'swingset_block_processing_seconds',
  ].map(name => createHistogram(metricMeter, name));

  /**
   * @param {any} policy
   * @param {() => number} clock
   */
  async function crankScheduler(policy, clock = () => Date.now()) {
    let now = clock();
    let crankStart = now;
    const blockStart = now;

    const instrumentedPolicy = harden({
      ...policy,
      crankComplete(details) {
        const go = policy.crankComplete(details);
        schedulerCrankTimeHistogram.record(now - crankStart, attributes);
        crankStart = now;
        now = clock();
        return go;
      },
    });
    await controller.run(instrumentedPolicy);

    now = Date.now();
    schedulerBlockTimeHistogram.record((now - blockStart) / 1000, attributes);
  }

  return {
    crankScheduler,
    schedulerCrankTimeHistogram,
    schedulerBlockTimeHistogram,
  };
}
