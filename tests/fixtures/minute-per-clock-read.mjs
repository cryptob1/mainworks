// GY-3975 test seam: once this process is a Playwright worker (it sets TEST_WORKER_INDEX as it starts), every read
// of the wall clock is one minute later than the last, as if each came after a long stall on a loaded host.
// Playwright's own timeouts run on a monotonic clock, and no other process of the run is a worker.
const RealDate = Date;
let skew = 0;
const read = () => process.env.TEST_WORKER_INDEX === undefined ? RealDate.now() : RealDate.now() + (skew += 60_000);
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(read()); }
  static now() { return read(); }
};
