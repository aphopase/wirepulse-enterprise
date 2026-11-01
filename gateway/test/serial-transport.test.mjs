// The real serial transport (the `serialport` package, termios, a character device) against a pseudo-terminal. A pty is not a USB UART:
// it has no baud clock, no wiring and no vendor driver, so this does not replace a test with the device on the bench. It does exercise
// everything the gateway itself does between the operating system's tty layer and the job: opening, framing, writing, closing.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { openSerialTransport } from "../src/transports.mjs";

let installed = true;
try { await import("serialport"); } catch { installed = false; }
const skip = !installed ? "the optional serialport package is not installed (npm ci in gateway/)"
  : spawnSync("python3", ["-I", "-c", "import pty"]).status !== 0 ? "python3 with the pty module is needed to play the device" : false;

// The device end of a pty. Standard input drives it ("W <hex>" writes those bytes to the port), standard output reports ("PATH <tty>",
// "R <hex>" for whatever the port wrote).
const DEVICE = `
import os, pty, sys, threading, tty
master, slave = pty.openpty()
tty.setraw(slave)
print("PATH " + os.ttyname(slave), flush=True)
def pump():
    while True:
        try: data = os.read(master, 4096)
        except OSError: return
        if not data: return
        print("R " + data.hex(), flush=True)
threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    command, _, argument = line.strip().partition(" ")
    if command == "W": os.write(master, bytes.fromhex(argument))
    elif command == "Q": break
`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i += 1) { const value = check(); if (value) return value; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}

async function startDevice() {
  const child = spawn("python3", ["-I", "-c", DEVICE], { stdio: ["pipe", "pipe", "inherit"] });
  const device = { received: Buffer.alloc(0), path: null };
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("PATH ")) device.path = line.slice(5);
    else if (line.startsWith("R ")) device.received = Buffer.concat([device.received, Buffer.from(line.slice(2), "hex")]);
  });
  device.write = (bytes) => child.stdin.write(`W ${Buffer.from(bytes).toString("hex")}\n`);
  device.stop = () => { child.stdin.write("Q\n"); child.stdin.end(); };
  await until(() => device.path, "the pseudo-terminal");
  return device;
}

async function withPort(run) {
  const device = await startDevice();
  const transport = await openSerialTransport({ path: device.path, baudRate: 115200 });
  const lines = [];
  transport.subscribe((line) => lines.push(line.text));
  try { await run({ device, transport, lines }); } finally { await transport.close(); device.stop(); }
}

test("send writes the command and a line ending to the device, and says how many bytes that was", { skip }, () => withPort(async ({ device, transport }) => {
  const receipt = await transport.send("AT+VER");
  assert.deepEqual([receipt.sequence, receipt.byteLength], [1, 7]);
  await until(() => device.received.toString() === "AT+VER\n", "the device to read the command");
  assert.equal((await transport.send("AT+ID")).sequence, 2);
}));

test("a line that reaches the port in pieces is delivered once, whole, and in order with the lines around it", { skip }, () => withPort(async ({ device, lines, transport }) => {
  device.write(Buffer.from("REA"));
  await sleep(80);
  assert.deepEqual(lines, [], "nothing is delivered before the line is complete");
  device.write(Buffer.from("DY\r\nsecond\r\nthi"));
  await until(() => lines.length === 2, "two complete lines");
  assert.deepEqual(lines, ["READY", "second"]);
  device.write(Buffer.from("rd\n"));
  await until(() => lines.length === 3, "the third line");
  assert.deepEqual(lines, ["READY", "second", "third"]);
  assert.equal(transport.rxSequence(), 2, "the sequence counts reads that completed lines (two lines arrived together in the first)");
}));

test("a multi-byte character split across two reads arrives intact", { skip }, () => withPort(async ({ device, lines }) => {
  device.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); // "caf" and the first byte of é
  await sleep(80);
  device.write(Buffer.from([0xa9, 0x0a])); // the rest of é, then the newline
  await until(() => lines.length === 1, "the line");
  assert.deepEqual(lines, ["café"]);
}));

test("closing releases the port so it can be opened again, and a port that is not there is an error", { skip }, async () => {
  const device = await startDevice();
  try {
    const first = await openSerialTransport({ path: device.path });
    await first.close();
    const second = await openSerialTransport({ path: device.path });
    await second.send("again");
    await until(() => device.received.toString() === "again\n", "the reopened port to write");
    await second.close();
  } finally { device.stop(); }
  await assert.rejects(openSerialTransport({ path: "/dev/wirepulse-no-such-port" }), /No such file|cannot open|ENOENT|File not found/i);
});
