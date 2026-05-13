/**
 * Simple progress display for long-running layer operations.
 */

export class Progress {
  constructor(label, total) {
    this.label = label;
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.lastPrint = 0;
  }

  tick(n = 1) {
    this.current += n;
    const now = Date.now();
    // Print at most once per second
    if (now - this.lastPrint >= 1_000 || this.current >= this.total) {
      this.print();
      this.lastPrint = now;
    }
  }

  print() {
    const pct = this.total > 0 ? ((this.current / this.total) * 100).toFixed(1) : '0.0';
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const rate = this.current > 0 ? (this.current / (elapsed || 1)).toFixed(0) : '0';
    const eta = this.current > 0 && this.current < this.total
      ? (((this.total - this.current) / (this.current / (elapsed || 1)))).toFixed(0)
      : '0';

    process.stdout.write(
      `\r  [${this.label}] ${this.current.toLocaleString()}/${this.total.toLocaleString()} (${pct}%) | ${rate}/s | ${elapsed}s elapsed | ~${eta}s remaining   `
    );

    if (this.current >= this.total) {
      process.stdout.write('\n');
    }
  }

  done() {
    this.current = this.total;
    this.print();
  }
}
