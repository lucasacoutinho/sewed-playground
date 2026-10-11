import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNative } from "./verify-native.mjs";

// The paths that normally need hardware or a system credential store, exercised with stand-ins
// Chromium itself provides or reads: a virtual authenticator for WebAuthn, and a throwaway home
// directory whose certificate store receives a client certificate made here.
const work = mkdtempSync(join(tmpdir(), "sewed-hardware-"));
const openssl = (...args) => execFileSync("openssl", args, { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Sewed Test CA", "-keyout", "ca.key", "-out", "ca.pem");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr");
openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-out", "server.pem");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Sewed Test Client", "-keyout", "client.key", "-out", "client.csr");
openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-out", "client.pem");
openssl("pkcs12", "-export", "-inkey", "client.key", "-in", "client.pem", "-name", "Sewed Test Client", "-passout", "pass:sewed", "-out", "client.p12");

// Bluetooth: a private bus stands in for the system bus, with a stand-in for the BlueZ daemon on
// it that has one adapter and announces one device when a scan starts.
const busAddress = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], {
  encoding: "utf8",
});
const [address, daemonPid] = busAddress.trim().split("\n");
const bluez = spawn("python3", ["scripts/fake-bluez.py"], {
  env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: address },
  stdio: ["ignore", "pipe", "inherit"],
});
let bluezLog = "";
bluez.stdout.setEncoding("utf8");
bluez.stdout.on("data", (chunk) => {
  bluezLog += chunk;
});
const stop = () => {
  bluez.kill();
  try {
    process.kill(Number(daemonPid));
  } catch {
    // Already gone.
  }
};
process.on("exit", stop);
for (const deadline = Date.now() + 10_000; !bluezLog.includes("READY"); ) {
  if (Date.now() > deadline) throw new Error("the stand-in BlueZ service did not start");
  await new Promise((resolve) => setTimeout(resolve, 50));
}

try {
await verifyNative({
  fixture: "scripts/hardware-fixture.mjs",
  artifact: "hardware",
  marker: "HARDWARE_VERIFICATION",
  // Chromium keeps Web Bluetooth behind its experimental web platform flag on Linux.
  electronArgs: ["--ozone-platform=x11", "--enable-experimental-web-platform-features"],
  // A home of its own: the client certificate is imported into this directory's store, never
  // the user's.
  env: { HOME: join(work, "home"), SEWED_HARDWARE_WORK: work, DBUS_SYSTEM_BUS_ADDRESS: address },
});
} finally {
  console.log(bluezLog.trim().replace(/^/gm, "bluez: "));
  stop();
}
