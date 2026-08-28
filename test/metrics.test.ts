import { Stat, Rate, PeerMetrics, M, timed } from "../src/metrics";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

console.log("\n— Stat percentiles —");
{
  const s = new Stat("ms");
  for (let i = 1; i <= 100; i++) s.push(i);
  ok("p50 of 1..100", Math.abs(s.p50 - 50) <= 1, `${s.p50}`);
  ok("p95 of 1..100", Math.abs(s.p95 - 95) <= 1, `${s.p95}`);
  ok("mean", Math.abs(s.mean - 50.5) < 1e-9, `${s.mean}`);
  ok("max", s.max === 100);
  ok("count tracks every push", s.count === 100);
}

console.log("\n— ring buffer forgets old samples —");
{
  // The window is what makes this a *live* metric rather than a lifetime
  // average: a stage that was slow a minute ago must not colour the reading now.
  const s = new Stat();
  for (let i = 0; i < 240; i++) s.push(1000); // fill with slow samples
  for (let i = 0; i < 240; i++) s.push(1); // then a full window of fast ones
  ok("old values evicted", s.p95 === 1, `p95=${s.p95}`);
  ok("total still counts everything", s.count === 480, `${s.count}`);
  ok("filled caps at the window", s.filled === 240, `${s.filled}`);
}

console.log("\n— Stat is robust to junk —");
{
  const s = new Stat();
  ok("empty p50 is NaN, not 0", Number.isNaN(s.p50));
  s.push(NaN); s.push(Infinity);
  ok("non-finite values are ignored", s.filled === 0, `${s.filled}`);
  s.push(5);
  ok("still usable after junk", s.p50 === 5);
}

console.log("\n— Rate —");
{
  const r = new Rate(1000, "fps");
  for (let i = 0; i < 10; i++) r.mark(1000 + i * 100); // 10 events over 1s
  ok("~10/s", Math.abs(r.perSecond(2000) - 10) <= 1.5, `${r.perSecond(2000).toFixed(2)}`);
  // A stall must read as zero, which a decaying average would not do.
  ok("drops to 0 after the window passes", r.perSecond(10_000) === 0, `${r.perSecond(10_000)}`);
}
{
  const r = new Rate(1000, "B/s");
  r.mark(0, 5000); r.mark(500, 5000);
  ok("sums amounts, not just events", r.perSecond(900) >= 9000, `${r.perSecond(900).toFixed(0)}`);
}

console.log("\n— timed() —");
{
  const s = new Stat();
  const out = timed(s, () => { let x = 0; for (let i = 0; i < 1e6; i++) x += i; return x; });
  ok("returns the callback value", out === 499999500000, `${out}`);
  ok("recorded one sample", s.filled === 1);
  ok("sample is positive", s.p50 > 0, `${s.p50.toFixed(3)}ms`);

  const s2 = new Stat();
  try { timed(s2, () => { throw new Error("boom"); }); } catch { /* expected */ }
  ok("records even when the block throws", s2.filled === 1);
}

console.log("\n— PeerMetrics —");
{
  const p = new PeerMetrics();
  p.faceGap.push(100); p.faceGap.push(120);
  p.lastFaceAt = 5000;
  const snap = p.snapshot(5250);
  ok("staleness measured from last frame", snap.staleMs === 250, `${snap.staleMs}`);
  ok("gap percentiles present", snap.faceGapMs.p50 !== null);
  const fresh = new PeerMetrics().snapshot(1000);
  ok("null staleness before any frame", fresh.staleMs === null);
}

console.log("\n— registry —");
{
  const a = M.peer(42);
  ok("peer() is stable per id", M.peer(42) === a);
  M.dropPeer(42);
  ok("dropPeer removes it", M.peer(42) !== a);
  M.dropPeer(42);

  M.detect.push(12);
  const snap = M.snapshot(performance.now());
  ok("snapshot has the pipeline stages", "detectMs" in snap.local && "encodeMs" in snap.local);
  ok("snapshot has transport", "rttMs" in snap.transport && "bufferedBytes" in snap.transport);
  ok("snapshot serialises to JSON", typeof JSON.stringify(snap) === "string");
}

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
