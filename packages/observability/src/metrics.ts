/**
 * Dependency-free metrics primitives (Counter / Gauge / Histogram) and a
 * Registry that renders them to the Prometheus text exposition format.
 *
 * No prom-client, no other external package -- same reasoning as the logger
 * in this package: the actual requirement (a handful of counters/gauges and
 * one histogram, rendered by an HTTP handler) does not justify a dependency.
 * Swap in prom-client later if you outgrow this; every call site already goes
 * through Counter/Gauge/Histogram rather than touching a library directly.
 *
 * Format reference: the Prometheus text-based exposition format (still
 * version 0.0.4 of the format, distinct from Prometheus-the-server's own
 * version):
 * https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md
 *
 * This module deliberately defines no metrics of its own -- only the generic
 * Counter/Gauge/Histogram/Registry primitives. The metrics a service actually
 * exposes belong next to the code that observes them
 * (backend/src/lib/metrics.ts here), so a metric and its call site cannot
 * drift apart.
 */

export type LabelValues = Record<string, string>;

type MetricType = "counter" | "gauge" | "histogram";

// https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md#metric-names-and-labels
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * HELP text escaping per the exposition format: backslash and line feed are
 * escaped; everything else (including `"`) passes through unescaped in HELP
 * lines specifically.
 */
function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Label-value escaping per the exposition format: backslash, double quote,
 * and line feed are escaped -- label values are always double-quoted, so `"`
 * additionally needs escaping (unlike HELP text, which isn't quoted).
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labelNames: readonly string[], values: LabelValues): string {
  if (labelNames.length === 0) {
    return "";
  }
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(values[name] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

/**
 * Order-independent identity for one label-value combination, so a metric
 * observed as `{a:"1",b:"2"}` and later as `{b:"2",a:"1"}` collide on the
 * same series instead of silently doubling cardinality. `labelNames` is
 * fixed per metric (validated below), so joining in that fixed order is
 * enough -- no need to sort per call.
 */
function seriesKey(labelNames: readonly string[], values: LabelValues): string {
  return labelNames.map((name) => values[name] ?? "").join("\u0000");
}

abstract class BaseMetric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  abstract readonly type: MetricType;

  protected constructor(opts: { name: string; help: string; labelNames?: readonly string[] }) {
    if (!METRIC_NAME_RE.test(opts.name)) {
      throw new Error(`invalid metric name "${opts.name}"`);
    }
    for (const labelName of opts.labelNames ?? []) {
      if (!LABEL_NAME_RE.test(labelName)) {
        throw new Error(`invalid label name "${labelName}" on metric "${opts.name}"`);
      }
    }
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  /**
   * Every call site must supply exactly the labels this metric declared --
   * no more, no fewer. This is deliberately strict: a typo'd label name
   * (`stype` instead of `type`) would otherwise create a second, silently
   * wrong series instead of failing loudly. It does NOT protect against
   * high-cardinality label *values* (e.g. passing a job id instead of a
   * bounded job type) -- that's a call-site responsibility this type system
   * can't enforce.
   */
  protected validateLabels(values: LabelValues): void {
    const provided = Object.keys(values);
    if (
      provided.length !== this.labelNames.length ||
      !this.labelNames.every((name) => name in values)
    ) {
      throw new Error(
        `metric "${this.name}" expects labels [${this.labelNames.join(", ")}] but got [${provided.join(", ")}]`,
      );
    }
  }

  protected renderHeader(): string {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract collect(): string;
}

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

/**
 * Monotonically increasing counter (e.g. `job_failed_total{type}`).
 *
 * A zero-label counter starts pre-seeded at 0 so it appears in `/metrics`
 * (as most scrapers expect for a "this has never happened yet" series)
 * before the first `inc()`. A labeled counter cannot do the same -- its
 * label values aren't known until first use -- so labeled series appear
 * only once observed, matching the same tradeoff most metrics libraries
 * make.
 */
export class Counter extends BaseMetric {
  readonly type = "counter" as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(opts: MetricOptions) {
    super(opts);
    if (this.labelNames.length === 0) {
      this.series.set("", { labels: {}, value: 0 });
    }
  }

  inc(labels: LabelValues = {}, value = 1): void {
    if (value < 0) {
      throw new Error(`counter "${this.name}" cannot be incremented by a negative value`);
    }
    this.validateLabels(labels);
    const key = seriesKey(this.labelNames, labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.series.set(key, { labels, value });
    }
  }

  collect(): string {
    let out = this.renderHeader();
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${formatLabels(this.labelNames, labels)} ${value}\n`;
    }
    return out;
  }
}

/**
 * Point-in-time value that can go up or down (e.g. `in_flight_requests`, a
 * queue depth, a connection-pool size).
 */
export class Gauge extends BaseMetric {
  readonly type = "gauge" as const;
  private readonly series = new Map<string, { labels: LabelValues; value: number }>();

  constructor(opts: MetricOptions) {
    super(opts);
    if (this.labelNames.length === 0) {
      this.series.set("", { labels: {}, value: 0 });
    }
  }

  set(labels: LabelValues, value: number): void;
  set(value: number): void;
  set(labelsOrValue: LabelValues | number, maybeValue?: number): void {
    let labels: LabelValues;
    let value: number;
    if (typeof labelsOrValue === "number") {
      labels = {};
      value = labelsOrValue;
    } else {
      labels = labelsOrValue;
      value = maybeValue ?? 0;
    }
    this.validateLabels(labels);
    const key = seriesKey(this.labelNames, labels);
    this.series.set(key, { labels, value });
  }

  inc(labels: LabelValues = {}, value = 1): void {
    this.validateLabels(labels);
    const key = seriesKey(this.labelNames, labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.series.set(key, { labels, value });
    }
  }

  dec(labels: LabelValues = {}, value = 1): void {
    this.inc(labels, -value);
  }

  collect(): string {
    let out = this.renderHeader();
    for (const { labels, value } of this.series.values()) {
      out += `${this.name}${formatLabels(this.labelNames, labels)} ${value}\n`;
    }
    return out;
  }
}

export interface HistogramOptions extends MetricOptions {
  /**
   * Upper (inclusive) bucket bounds, ascending. The `+Inf` bucket is always
   * added implicitly and must not be included here.
   */
  buckets?: readonly number[];
}

/**
 * Default bucket layout for a metric measured in seconds and expected to
 * mostly land under a few seconds, with a long tail out to 60s. Retune these
 * against real measurements once you have them -- bucket bounds are the one
 * part of a histogram you cannot fix retroactively, since the raw
 * observations are gone.
 */
const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

interface HistogramSeries {
  labels: LabelValues;
  /** Cumulative per-bucket counts -- bucketCounts[i] already counts every observation <= buckets[i]. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * Cumulative histogram (e.g. `job_duration_seconds{type}`). Renders the
 * `_bucket` (with the implicit `+Inf` bucket), `_sum`, and `_count` series
 * the exposition format requires for a histogram.
 */
export class Histogram extends BaseMetric {
  readonly type = "histogram" as const;
  private readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(opts: HistogramOptions) {
    super(opts);
    // "le" is injected by collect() below to carry the bucket bound -- a
    // caller-declared "le" label would silently collide with it.
    if (this.labelNames.includes("le")) {
      throw new Error(`histogram "${this.name}" cannot declare a label named "le"`);
    }
    const buckets = [...(opts.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b);
    if (buckets.some((b) => !Number.isFinite(b))) {
      throw new Error(
        `histogram "${this.name}" buckets must be finite (the +Inf bucket is implicit)`,
      );
    }
    this.buckets = buckets;
    if (this.labelNames.length === 0) {
      this.series.set("", this.emptySeries({}));
    }
  }

  private emptySeries(labels: LabelValues): HistogramSeries {
    return {
      labels,
      bucketCounts: new Array<number>(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
  }

  observe(labels: LabelValues, value: number): void;
  observe(value: number): void;
  observe(labelsOrValue: LabelValues | number, maybeValue?: number): void {
    let labels: LabelValues;
    let value: number;
    if (typeof labelsOrValue === "number") {
      labels = {};
      value = labelsOrValue;
    } else {
      labels = labelsOrValue;
      value = maybeValue ?? 0;
    }
    this.validateLabels(labels);
    const key = seriesKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = this.emptySeries(labels);
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      // Every bucket >= the observed value gets incremented, so
      // bucketCounts[i] is already the cumulative "<= buckets[i]" count --
      // no separate running total needed when rendering.
      if (value <= this.buckets[i]!) {
        entry.bucketCounts[i]!++;
      }
    }
  }

  collect(): string {
    let out = this.renderHeader();
    for (const { labels, bucketCounts, sum, count } of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels = { ...labels, le: String(this.buckets[i]) };
        out += `${this.name}_bucket${formatLabels([...this.labelNames, "le"], bucketLabels)} ${bucketCounts[i]}\n`;
      }
      const infLabels = { ...labels, le: "+Inf" };
      out += `${this.name}_bucket${formatLabels([...this.labelNames, "le"], infLabels)} ${count}\n`;
      out += `${this.name}_sum${formatLabels(this.labelNames, labels)} ${sum}\n`;
      out += `${this.name}_count${formatLabels(this.labelNames, labels)} ${count}\n`;
    }
    return out;
  }
}

export type Metric = Counter | Gauge | Histogram;

/**
 * Holds a set of metrics and renders them together as one Prometheus text
 * exposition body. Deliberately NOT a process-wide singleton that metrics
 * auto-register into on construction -- constructing a Counter/Gauge/
 * Histogram has no side effects, so tests can build as many of them as they
 * like without colliding on names in some shared default registry.
 * `defaultRegistry` below exists for the process that wants exactly that
 * convenience; using it is not required.
 */
export class Registry {
  private readonly metrics = new Map<string, Metric>();

  register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`metric "${metric.name}" is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  unregister(name: string): void {
    this.metrics.delete(name);
  }

  clear(): void {
    this.metrics.clear();
  }

  /** Full Prometheus text exposition body for every registered metric. */
  metricsText(): string {
    let out = "";
    for (const metric of this.metrics.values()) {
      out += metric.collect();
    }
    return out;
  }
}

/**
 * Convenience shared registry backing GET /metrics. Using it is optional --
 * construct a private `Registry` instead wherever sharing process-wide state
 * would be a liability (tests, in particular).
 */
export const defaultRegistry = new Registry();
