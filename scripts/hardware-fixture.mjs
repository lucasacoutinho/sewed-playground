import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { app, BrowserWindow as NativeBrowserWindow } from "electron";
import { Cause, Effect, Redacted } from "effect";
import { Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, Session } from "sewed/main";

const work = process.env.SEWED_HARDWARE_WORK;
assert.ok(work, "run through scripts/verify-hardware.mjs");
mkdirSync(process.env.HOME, { recursive: true });

const checks = [];
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const until = (read, description, timeout = 15_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = read();
      if (value) return value;
      assert.ok(Date.now() < deadline, `Timed out: ${description}`);
      yield* Effect.sleep(25);
    }
  });
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const page = "<!doctype html><title>Sewed hardware</title><p>hardware</p>";

const webAuthn = Effect.gen(function* () {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  const port = yield* Effect.promise(() => listen(server));
  // WebAuthn needs a secure context and a relying party id; `localhost` is both.
  const origin = `http://localhost:${port}`;
  const session = yield* Session.fromPartition({ kind: "memory", name: `webauthn-${process.pid}` });
  const asked = [];
  yield* session.decide(
    Decidables.Session.WebAuthnAccount,
    Decision.async((request) =>
      Effect.sync(() => {
        asked.push(request);
        const chosen = request.accounts.find((account) => account.name === "second@example.com");
        return chosen === undefined ? { kind: "cancel" } : { kind: "select", id: chosen.credentialId };
      }),
    ),
  );
  const window = yield* BrowserWindow.make({ show: true, session, title: "Sewed webauthn" });
  yield* window.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
  const native = NativeBrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(origin));
  assert.ok(native, "the native window");
  const cdp = native.webContents.debugger;
  cdp.attach("1.3");
  const send = (method, params) => Effect.promise(() => cdp.sendCommand(method, params));
  yield* send("WebAuthn.enable", { enableUI: true });
  const { authenticatorId } = yield* send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const credentials = ["first@example.com", "second@example.com"].map((name, index) => ({
    name,
    id: randomBytes(16).toString("base64"),
    handle: Buffer.from(`user-${index}`).toString("base64"),
    key: generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64"),
  }));
  for (const credential of credentials)
    yield* send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: credential.id,
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: credential.key,
        userHandle: credential.handle,
        userName: credential.name,
        userDisplayName: credential.name,
        signCount: 0,
      },
    });
  native.focus();
  const outcome = yield* Effect.promise(() =>
    native.webContents.executeJavaScript(
      `navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: "localhost", userVerification: "preferred" } })
        .then((credential) => ({ id: credential.id, user: new TextDecoder().decode(credential.response.userHandle) }))
        .catch((error) => ({ error: String(error && error.name) + ": " + String(error && error.message) }))`,
      true,
    ),
  ).pipe(Effect.timeoutOption("20 seconds"));
  cdp.detach();
  server.close();
  assert.equal(outcome._tag, "Some", "the credential request settled");
  assert.equal(asked.length, 1, `the WebAuthn decider was asked once: ${JSON.stringify(outcome.value)}`);
  assert.equal(asked[0].relyingPartyId, "localhost");
  assert.equal(asked[0].origin, origin);
  assert.deepEqual(asked[0].accounts.map((account) => account.name).sort(), ["first@example.com", "second@example.com"]);
  assert.equal(outcome.value.user, "user-1", JSON.stringify(outcome.value));
  record("a WebAuthn request with two discoverable credentials asks the session's decider, and its choice signs in", {
    accounts: asked[0].accounts.length,
    relyingPartyId: asked[0].relyingPartyId,
    chosenUser: outcome.value.user,
  });
});

const bluetooth = Effect.gen(function* () {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  const port = yield* Effect.promise(() => listen(server));
  const origin = `http://localhost:${port}`;
  const window = yield* BrowserWindow.make({ show: true, title: "Sewed bluetooth" });
  const reports = [];
  yield* window.webContents.decide(
    Decidables.WebContents.BluetoothDevice,
    Decision.async((request) =>
      Effect.sync(() => {
        reports.push(request);
        const sensor = request.devices.find((device) => device.deviceName === "Sewed Sensor");
        return sensor === undefined ? { kind: "wait" } : { kind: "select", id: sensor.deviceId };
      }),
    ),
  );
  const pairings = [];
  yield* (yield* Session.defaultSession).decide(
    Decidables.Session.BluetoothPairing,
    Decision.async((request) =>
      Effect.sync(() => {
        pairings.push(request);
        return request.kind === "providePin" ? { kind: "pin", pin: "123456" } : { kind: "confirm" };
      }),
    ),
  );
  yield* window.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
  const native = NativeBrowserWindow.getAllWindows().find((each) => each.webContents.getURL().startsWith(origin));
  assert.ok(native, "the native window");
  native.focus();
  const outcome = yield* Effect.promise(() =>
    native.webContents.executeJavaScript(
      `(navigator.bluetooth === undefined ? Promise.resolve({ error: "navigator.bluetooth is undefined" }) : navigator.bluetooth.getAvailability().then((available) =>
         navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ["battery_service"] })
           .then((device) => {
             globalThis.sewedDevice = device;
             return { available, name: device.name, id: device.id };
           })
           .catch((error) => ({ available, error: String(error && error.name) + ": " + String(error && error.message) }))))`,
      true,
    ),
  ).pipe(Effect.timeoutOption("25 seconds"));
  server.close();
  assert.equal(outcome._tag, "Some", `the Bluetooth request settled; reports: ${JSON.stringify(reports)}`);
  assert.equal(outcome.value.name, "Sewed Sensor", `${JSON.stringify(outcome.value)}; reports: ${JSON.stringify(reports)}`);
  assert.ok(reports.length >= 1);
  assert.equal(reports.at(-1).origin, origin);
  record("a Bluetooth scan reports its devices to the page's decider, and the one it selects reaches the page", {
    reports: reports.map((report) => report.devices.map((device) => device.deviceName)),
    device: outcome.value.name,
  });

  // The device refuses a read until it is paired; pairing asks the session's decider.
  const read = yield* Effect.promise(() =>
    native.webContents.executeJavaScript(
      `globalThis.sewedDevice.gatt.connect()
         .then((gatt) => gatt.getPrimaryService("battery_service"))
         .then((service) => service.getCharacteristic("battery_level"))
         .then((characteristic) => characteristic.readValue())
         .then((value) => ({ level: value.getUint8(0) }))
         .catch((error) => ({ error: String(error && error.name) + ": " + String(error && error.message) }))`,
      true,
    ),
  ).pipe(Effect.timeoutOption("30 seconds"));
  assert.equal(read._tag, "Some", `the read settled; pairings: ${JSON.stringify(pairings)}`);
  assert.equal(read.value.level, 42, `${JSON.stringify(read.value)}; pairings: ${JSON.stringify(pairings)}`);
  assert.equal(pairings.length, 1, "the pairing decider was asked once");
  assert.equal(typeof pairings[0].deviceId, "string");
  record("a device that demands pairing asks the session's pairing decider, and a confirmation lets the read through", {
    kind: pairings[0].kind,
    pin: pairings[0].pin ?? null,
    level: read.value.level,
  });
});

const clientCertificate = Effect.gen(function* () {
  const seen = [];
  const server = createHttpsServer(
    {
      key: readFileSync(join(work, "server.key")),
      cert: readFileSync(join(work, "server.pem")),
      ca: readFileSync(join(work, "ca.pem")),
      requestCert: true,
      rejectUnauthorized: false,
    },
    (request, response) => {
      const peer = request.socket.getPeerCertificate();
      seen.push(peer?.subject?.CN ?? null);
      response.writeHead(200, { "content-type": "text/html" }).end(page);
    },
  );
  const port = yield* Effect.promise(() => listen(server));
  const origin = `https://localhost:${port}`;
  yield* App.importCertificate({
    certificate: join(work, "client.p12"),
    password: Redacted.make("sewed"),
  });
  // The server's certificate comes from a test authority no store trusts.
  yield* App.decide(
    Decidables.App.CertificateError,
    Decision.async((error) => Effect.succeed(error.hostname === "localhost" ? "trust" : "reject")),
  );
  const offered = [];
  yield* App.decide(
    Decidables.App.ClientCertificate,
    Decision.async((request) =>
      Effect.sync(() => {
        offered.push(request);
        const mine = request.certificates.find((certificate) => certificate.subjectName === "Sewed Test Client");
        return mine === undefined ? { kind: "none" } : { kind: "select", fingerprint: mine.fingerprint };
      }),
    ),
  );
  const window = yield* BrowserWindow.make({ show: false, title: "Sewed client certificate" });
  yield* window.webContents.load(Renderer.entry(new URL("/", origin), { bindings: [] }), { bindings: [] });
  yield* until(() => seen.length > 0, "the server saw a request");
  server.close();
  assert.equal(offered.length >= 1, true, "the client certificate decider was asked");
  // Electron names the server by host and port here, not by a full URL.
  assert.ok(offered[0].url.includes(`localhost:${port}`), offered[0].url);
  assert.ok(offered[0].certificates.some((certificate) => certificate.subjectName === "Sewed Test Client"));
  assert.ok(seen.includes("Sewed Test Client"), `the server received the chosen certificate: ${JSON.stringify(seen)}`);
  record("an imported client certificate is offered to the decider, and the one it selects reaches the server", {
    offered: offered[0].certificates.map((certificate) => certificate.subjectName),
    serverSaw: seen,
  });
});

async function verify() {
  await app.whenReady();
  App.run(
    [],
    Effect.gen(function* () {
      yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
      const failures = [];
      for (const [name, check] of [
        ["webauthn", webAuthn],
        ["client-certificate", clientCertificate],
        ["bluetooth", bluetooth],
      ]) {
        const result = yield* Effect.exit(Effect.scoped(check));
        if (result._tag === "Failure") failures.push(`${name}: ${Cause.pretty(result.cause)}`);
      }
      console.log(
        `HARDWARE_VERIFICATION ${JSON.stringify({
          success: failures.length === 0,
          checks,
          error: failures.length === 0 ? undefined : failures.join("\n---\n"),
        })}`,
      );
      if (failures.length > 0) app.exit(1);
      else yield* App.quit;
    }),
  );
}

void verify().catch((error) => {
  console.error(error);
  app.exit(1);
});
