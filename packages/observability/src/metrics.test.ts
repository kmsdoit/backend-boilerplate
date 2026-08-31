import { describe, expect, it } from "vitest";

import { Counter, Gauge, Histogram, Registry } from "./metrics.ts";

describe("Counter", () => {
  it("starts at 0 for a zero-label counter", () => {
    const counter = new Counter({ name: "job_failed_total", help: "failed jobs" });
    expect(counter.collect()).toBe(
      "# HELP job_failed_total failed jobs\n# TYPE job_failed_total counter\njob_failed_total 0\n",
    );
  });

  it("increments by 1 by default and by an explicit amount", () => {
    const counter = new Counter({ name: "c", help: "h" });
    counter.inc();
    counter.inc({}, 4);
    expect(counter.collect()).toContain("c 5\n");
  });

  it("tracks separate series per label combination", () => {
    const counter = new Counter({ name: "job_failed_total", help: "h", labelNames: ["type"] });
    counter.inc({ type: "tenant.provision" });
    counter.inc({ type: "tenant.provision" });
    counter.inc({ type: "tenant.delete" });

    const text = counter.collect();
    expect(text).toContain('job_failed_total{type="tenant.provision"} 2\n');
    expect(text).toContain('job_failed_total{type="tenant.delete"} 1\n');
  });

  it("label combinations are order-independent", () => {
    const counter = new Counter({ name: "c", help: "h", labelNames: ["a", "b"] });
    counter.inc({ a: "1", b: "2" });
    counter.inc({ b: "2", a: "1" });

    const lines = counter.collect().trim().split("\n");
    // HELP + TYPE + exactly one series line -- if order mattered these would
    // have collided into two series instead of accumulating into one.
    expect(lines).toHaveLength(3);
    expect(counter.collect()).toContain('c{a="1",b="2"} 2\n');
  });

  it("rejects a negative increment", () => {
    const counter = new Counter({ name: "c", help: "h" });
    expect(() => counter.inc({}, -1)).toThrow(/negative/);
  });

  it("rejects label sets that don't exactly match the declared label names", () => {
    const counter = new Counter({ name: "c", help: "h", labelNames: ["type"] });
    expect(() => counter.inc({ stype: "x" })).toThrow(/expects labels \[type\]/);
    expect(() => counter.inc({ type: "x", extra: "y" })).toThrow(/expects labels \[type\]/);
    expect(() => counter.inc()).toThrow(/expects labels \[type\]/);
  });

  it("rejects an invalid metric or label name", () => {
    expect(() => new Counter({ name: "0-bad", help: "h" })).toThrow(/invalid metric name/);
    expect(() => new Counter({ name: "ok", help: "h", labelNames: ["bad-label"] })).toThrow(
      /invalid label name/,
    );
  });
});

describe("Gauge", () => {
  it("supports set/inc/dec for a zero-label gauge", () => {
    const gauge = new Gauge({ name: "queue_depth", help: "pgmq depth" });
    gauge.set(10);
    expect(gauge.collect()).toContain("queue_depth 10\n");
    gauge.inc();
    expect(gauge.collect()).toContain("queue_depth 11\n");
    gauge.dec(undefined, 5);
    expect(gauge.collect()).toContain("queue_depth 6\n");
  });

  it("supports set/inc/dec per label combination", () => {
    const gauge = new Gauge({ name: "g", help: "h", labelNames: ["type"] });
    gauge.set({ type: "a" }, 3);
    gauge.inc({ type: "a" }, 2);
    gauge.set({ type: "b" }, 1);

    const text = gauge.collect();
    expect(text).toContain('g{type="a"} 5\n');
    expect(text).toContain('g{type="b"} 1\n');
  });

  it("can go down, unlike a Counter", () => {
    const gauge = new Gauge({ name: "stale_jobs_total", help: "stale jobs" });
    gauge.set(3);
    gauge.dec();
    gauge.dec();
    expect(gauge.collect()).toContain("stale_jobs_total 1\n");
  });
});

describe("Histogram", () => {
  it("increments every bucket >= the observed value, and +Inf always", () => {
    const histogram = new Histogram({
      name: "job_duration_seconds",
      help: "h",
      buckets: [1, 5, 10],
    });
    histogram.observe(0.5);
    histogram.observe(3);
    histogram.observe(20);

    const text = histogram.collect();
    expect(text).toContain('job_duration_seconds_bucket{le="1"} 1\n');
    expect(text).toContain('job_duration_seconds_bucket{le="5"} 2\n');
    expect(text).toContain('job_duration_seconds_bucket{le="10"} 2\n');
    expect(text).toContain('job_duration_seconds_bucket{le="+Inf"} 3\n');
    expect(text).toContain("job_duration_seconds_sum 23.5\n");
    expect(text).toContain("job_duration_seconds_count 3\n");
  });

  it("keeps separate bucket/sum/count series per label combination", () => {
    const histogram = new Histogram({
      name: "job_duration_seconds",
      help: "h",
      labelNames: ["type"],
      buckets: [1],
    });
    histogram.observe({ type: "tenant.provision" }, 0.4);
    histogram.observe({ type: "tenant.delete" }, 2);

    const text = histogram.collect();
    expect(text).toContain('job_duration_seconds_bucket{type="tenant.provision",le="1"} 1\n');
    expect(text).toContain('job_duration_seconds_bucket{type="tenant.provision",le="+Inf"} 1\n');
    expect(text).toContain('job_duration_seconds_bucket{type="tenant.delete",le="1"} 0\n');
    expect(text).toContain('job_duration_seconds_bucket{type="tenant.delete",le="+Inf"} 1\n');
    expect(text).toContain('job_duration_seconds_sum{type="tenant.delete"} 2\n');
  });

  it("sorts unsorted bucket options ascending and rejects a non-finite bucket", () => {
    const histogram = new Histogram({ name: "h", help: "h", buckets: [5, 1, 10] });
    histogram.observe(2);
    const lines = histogram.collect().split("\n");
    const bucketLines = lines.filter((l) => l.includes("_bucket{"));
    expect(bucketLines.map((l) => l.match(/le="([^"]+)"/)?.[1])).toEqual(["1", "5", "10", "+Inf"]);

    expect(() => new Histogram({ name: "bad", help: "h", buckets: [Infinity] })).toThrow(/finite/);
  });

  it('rejects a caller-declared "le" label, which collect() injects itself', () => {
    expect(() => new Histogram({ name: "h", help: "h", labelNames: ["le"] })).toThrow(
      /cannot declare a label named "le"/,
    );
  });

  it("defaults to a plausible bucket layout when none is given", () => {
    const histogram = new Histogram({ name: "h", help: "h" });
    histogram.observe(1);
    // Just confirms it doesn't throw and produces a +Inf bucket -- the exact
    // default layout is not a contract this test should pin down.
    expect(histogram.collect()).toContain('h_bucket{le="+Inf"} 1\n');
  });
});

describe("exposition format", () => {
  it("emits HELP before TYPE before the sample line", () => {
    const counter = new Counter({ name: "c", help: "some help text" });
    const lines = counter.collect().split("\n");
    expect(lines[0]).toBe("# HELP c some help text");
    expect(lines[1]).toBe("# TYPE c counter");
    expect(lines[2]).toBe("c 0");
  });

  it("escapes backslash and newline in HELP text", () => {
    const counter = new Counter({ name: "c", help: "back\\slash and\nnewline" });
    const line = counter.collect().split("\n")[0];
    expect(line).toBe("# HELP c back\\\\slash and\\nnewline");
  });

  it("escapes backslash, double-quote and newline in label values", () => {
    const counter = new Counter({ name: "c", help: "h", labelNames: ["reason"] });
    counter.inc({ reason: 'has "quotes", a\\backslash, and\na newline' });
    const text = counter.collect();
    expect(text).toContain('c{reason="has \\"quotes\\", a\\\\backslash, and\\na newline"} 1\n');
  });

  it("omits label braces entirely for a zero-label metric", () => {
    const gauge = new Gauge({ name: "queue_depth", help: "h" });
    gauge.set(1);
    expect(gauge.collect()).toContain("queue_depth 1\n");
    expect(gauge.collect()).not.toContain("{");
  });
});

describe("Registry", () => {
  it("concatenates every registered metric's exposition text", () => {
    const registry = new Registry();
    const counter = registry.register(new Counter({ name: "a_total", help: "h" }));
    const gauge = registry.register(new Gauge({ name: "b", help: "h" }));
    counter.inc();
    gauge.set(2);

    const text = registry.metricsText();
    expect(text).toContain("# TYPE a_total counter");
    expect(text).toContain("# TYPE b gauge");
    expect(text.indexOf("a_total")).toBeLessThan(text.indexOf("# TYPE b"));
  });

  it("rejects registering two metrics under the same name", () => {
    const registry = new Registry();
    registry.register(new Counter({ name: "dup", help: "h" }));
    expect(() => registry.register(new Counter({ name: "dup", help: "h2" }))).toThrow(
      /already registered/,
    );
  });

  it("unregister and clear remove metrics from metricsText()", () => {
    const registry = new Registry();
    registry.register(new Counter({ name: "a", help: "h" }));
    registry.register(new Gauge({ name: "b", help: "h" }));

    registry.unregister("a");
    expect(registry.metricsText()).not.toContain("# TYPE a ");

    registry.clear();
    expect(registry.metricsText()).toBe("");
  });

  it("does not auto-register metrics constructed independently of a registry", () => {
    const registry = new Registry();
    new Counter({ name: "not_registered", help: "h" });
    expect(registry.metricsText()).toBe("");
  });
});
