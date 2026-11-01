#!/usr/bin/env python3
"""Host stall probe, independent of WirePulse. Two threads for a fixed time:
  disk: write 8 KiB and fsync, 5 times per second (what PostgreSQL's WAL does), record the latency of each fsync;
  cpu : sleep 1 ms in a loop and record how late each wake-up is (scheduler / CPU contention).
Prints the distribution and every event slower than 250 ms with its UTC time.  Usage: scripts/host-stall-probe.py DIR SECONDS  (DIR must be on the disk you care about)"""
import os, sys, time, threading, datetime
d, secs = sys.argv[1], int(sys.argv[2])
os.makedirs(d, exist_ok=True)
end = time.monotonic() + secs
disk, cpu, events = [], [], []
def utc(): return datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3]
def disk_loop():
    fd = os.open(os.path.join(d, "stall.dat"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    buf = b"x" * 8192
    while time.monotonic() < end:
        t = time.monotonic(); os.pwrite(fd, buf, (len(disk) % 2048) * 8192); os.fsync(fd); dt = (time.monotonic() - t) * 1000
        disk.append(dt)
        if dt > 250: events.append((utc(), "fsync", dt))
        time.sleep(0.2)
    os.close(fd); os.unlink(os.path.join(d, "stall.dat"))
def cpu_loop():
    while time.monotonic() < end:
        t = time.monotonic(); time.sleep(0.001); late = (time.monotonic() - t) * 1000 - 1
        cpu.append(late)
        if late > 250: events.append((utc(), "wakeup", late))
a, b = threading.Thread(target=disk_loop), threading.Thread(target=cpu_loop)
a.start(); b.start(); a.join(); b.join()
def pct(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(len(v) * p))]
for name, v in (("fsync ms", disk), ("wakeup lateness ms", cpu)):
    print(f"{name}: n={len(v)} p50={pct(v,.5):.2f} p99={pct(v,.99):.2f} p99.9={pct(v,.999):.2f} max={max(v):.1f} >100ms={sum(x>100 for x in v)} >250ms={sum(x>250 for x in v)} >1s={sum(x>1000 for x in v)}")
for e in sorted(events): print("EVENT", *e)
