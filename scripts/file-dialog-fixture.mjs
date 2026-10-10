import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow as NativeWindow, dialog } from "electron";
import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { Binding, Decidables, Decision, Renderer } from "sewed";
import { App, BrowserWindow, host } from "sewed/main";
import { Picker, PickerSlot } from "./file-dialog-contract.mjs";

const execFileAsync = promisify(execFile);
const checks = [];
const calls = [];
let sequence = 0;
const options = (extra = {}) => ({
  title: `Sewed file dialog ${process.pid} ${++sequence}`,
  buttonLabel: "_Select",
  ...extra,
});
const record = (name, evidence = {}) => {
  checks.push({ name, evidence: structuredClone(evidence) });
  console.log(`PASS ${name}`);
};
const waitUntil = (read, description) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (value) return value;
      yield* Effect.sleep(10);
    }
    throw new Error(`Timed out: ${description}`);
  });
const nativeDialog = (call, ...commands) =>
  Effect.promise(async () => {
    const { stdout } = await execFileAsync(
      "python3",
      ["scripts/file-dialog-window.py", String(process.pid), call.options.title, ...commands],
      { timeout: 10_000 },
    );
    return JSON.parse(stdout);
  });
const visibleDialog = (call) =>
  waitUntil(
    nativeDialog(call).pipe(
      Effect.map((windows) => {
        assert.ok(windows.length <= 1);
        const window = windows[0];
        if (window) assert.equal(window.parent, call.parentId);
        return window;
      }),
    ),
    `native picker ${call.options.title}`,
  );
const dismissed = (call) =>
  waitUntil(
    nativeDialog(call).pipe(Effect.map((windows) => call.settled && windows.length === 0)),
    `native picker dismissal ${call.options.title}`,
  );
const failure = (exit) => {
  assert.equal(exit._tag, "Failure");
  const error = Cause.findErrorOption(exit.cause);
  assert.equal(error._tag, "Some", Cause.pretty(exit.cause));
  return error.value;
};
const nextCall = (count) =>
  waitUntil(
    Effect.sync(() => calls.length > count && calls[count]),
    "native picker invocation",
  );
const start = (operation) =>
  Effect.gen(function* () {
    const count = calls.length;
    const fiber = yield* Effect.forkScoped(operation);
    return { fiber, call: yield* nextCall(count) };
  });
const respond = (request, key) =>
  Effect.gen(function* () {
    const native = yield* visibleDialog(request.call);
    yield* nativeDialog(request.call, key);
    const result = yield* Fiber.join(request.fiber).pipe(Effect.timeout(8_000));
    yield* dismissed(request.call);
    return { native, result, raw: request.call.result };
  });
const makeWindow = (name) =>
  Effect.gen(function* () {
    const title = `Sewed picker parent ${process.pid} ${name}`;
    const handle = yield* BrowserWindow.make({ title, width: 500, height: 300 });
    const native = NativeWindow.getAllWindows().find((window) => window.getTitle() === title);
    assert.ok(native);
    return { handle, native };
  });
const replaceNative = (method, replacement, program) =>
  Effect.scoped(
    Effect.gen(function* () {
      const original = dialog[method];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          dialog[method] = replacement;
        }),
        () =>
          Effect.sync(() => {
            dialog[method] = original;
          }),
      );
      return yield* program;
    }),
  );

const runChecks = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "sewed-picker-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const filesDirectory = path.join(directory, "files");
  const selectedFile = path.join(filesDirectory, "alpha.txt");
  const anotherFile = path.join(filesDirectory, "two words.txt");
  const selectedDirectory = path.join(directory, "folder");
  const savePath = path.join(directory, "saved.txt");
  yield* Effect.promise(async () => {
    await mkdir(filesDirectory);
    await writeFile(selectedFile, "Fixture file stays unchanged.\n");
    await writeFile(anotherFile, "Second fixture file.\n");
    await mkdir(selectedDirectory);
  });
  for (const method of ["showOpenDialog", "showSaveDialog", "showMessageBox"]) {
    const original = dialog[method];
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        dialog[method] = (parent, settings) => {
          const call = {
            method,
            parent,
            parentId: parent.getNativeWindowHandle().readUInt32LE(0),
            options: settings,
            settled: false,
          };
          calls.push(call);
          const pending = original.call(dialog, parent, settings);
          void pending.then(
            (result) => {
              call.result = result;
              call.settled = true;
            },
            (error) => {
              call.error = error;
              call.settled = true;
            },
          );
          return pending;
        };
      }),
      () =>
        Effect.sync(() => {
          dialog[method] = original;
        }),
    );
  }
  const first = yield* makeWindow("first");
  const second = yield* makeWindow("second");
  const input = options({
    mode: "file",
    defaultPath: selectedFile,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  const open = first.handle.dialog.open(input);
  const save = second.handle.dialog.save(options({ defaultPath: savePath }));
  assert.equal(calls.length, 0);
  record("file picker definitions are inert");

  const opened = yield* start(open);
  assert.equal(opened.call.parent, first.native);
  assert.notEqual(opened.call.options.filters, input.filters);
  assert.notEqual(opened.call.options.filters[0].extensions, input.filters[0].extensions);
  input.filters[0].extensions[0] = "pdf";
  assert.deepEqual(opened.call.options.filters, [{ name: "Text", extensions: ["txt"] }]);
  const file = yield* respond(opened, "open");
  assert.deepEqual(file.result, { kind: "selected", paths: [selectedFile] });
  assert.deepEqual(file.raw, { canceled: false, filePaths: [selectedFile] });
  record("a native file selection returns its real path from the selected parent", file);

  const folder = yield* start(
    first.handle.dialog.open(
      options({
        mode: "directory",
        defaultPath: selectedDirectory,
      }),
    ),
  );
  assert.deepEqual(folder.call.options.properties, ["openDirectory"]);
  const directoryResult = yield* respond(folder, "open");
  assert.deepEqual(directoryResult.result, { kind: "selected", paths: [selectedDirectory] });
  record(
    "directory mode selects a native directory without mixing file selection",
    directoryResult,
  );

  const saved = yield* start(save);
  assert.equal(saved.call.parent, second.native);
  assert.deepEqual(saved.call.options.properties, ["showOverwriteConfirmation"]);
  const saveResult = yield* respond(saved, "save");
  assert.deepEqual(saveResult.result, { kind: "selected", path: savePath });
  yield* Effect.promise(() => assert.rejects(stat(savePath), { code: "ENOENT" }));
  record("a native save dialog selects a destination without creating the file", saveResult);

  const overwrite = yield* start(second.handle.dialog.save(options({ defaultPath: selectedFile })));
  const saveWindow = yield* visibleDialog(overwrite.call);
  yield* nativeDialog(overwrite.call, "save");
  const confirmation = yield* waitUntil(
    Effect.gen(function* () {
      const { stdout } = yield* Effect.promise(() =>
        execFileAsync(
          "python3",
          [
            "scripts/file-dialog-window.py",
            String(process.pid),
            String(saveWindow.window),
            "confirmation",
          ],
          { timeout: 10_000 },
        ),
      );
      const windows = JSON.parse(stdout);
      assert.ok(windows.length <= 1);
      if (windows.length > 0) return { shown: true, window: windows[0] };
      if (overwrite.call.settled) return { shown: false };
    }),
    "save settlement or native overwrite confirmation",
  );
  if (confirmation.shown) {
    yield* Effect.promise(() =>
      execFileAsync(
        "python3",
        [
          "scripts/file-dialog-window.py",
          String(process.pid),
          String(saveWindow.window),
          "replace",
        ],
        { timeout: 10_000 },
      ),
    );
  }
  const replaced = yield* Fiber.join(overwrite.fiber).pipe(Effect.timeout(8_000));
  yield* dismissed(overwrite.call);
  assert.deepEqual(replaced, { kind: "selected", path: selectedFile });
  assert.equal(
    yield* Effect.promise(() => readFile(selectedFile, "utf8")),
    "Fixture file stays unchanged.\n",
  );
  record("selecting an existing save destination leaves its contents unchanged", {
    requestedOverwriteConfirmation: overwrite.call.options.properties.includes(
      "showOverwriteConfirmation",
    ),
    nativeConfirmation: confirmation,
    result: replaced,
  });

  for (const operation of [
    first.handle.dialog.open(options({ mode: "file", defaultPath: selectedFile })),
    second.handle.dialog.save(options({ defaultPath: savePath })),
  ]) {
    const canceled = yield* start(operation);
    const result = yield* respond(canceled, "Escape");
    assert.deepEqual(result.result, { kind: "canceled" });
  }
  record("user dismissal succeeds with a canceled result for open and save dialogs");

  const multiple = yield* start(
    first.handle.dialog.open(
      options({
        mode: "file",
        multiple: true,
        defaultPath: selectedFile,
      }),
    ),
  );
  yield* visibleDialog(multiple.call);
  assert.deepEqual(multiple.call.options.properties, ["openFile", "multiSelections"]);
  yield* nativeDialog(multiple.call, "all");
  yield* nativeDialog(multiple.call, "open");
  const selected = yield* Fiber.join(multiple.fiber).pipe(Effect.timeout(8_000));
  yield* dismissed(multiple.call);
  assert.equal(selected.kind, "selected");
  assert.deepEqual([...selected.paths].sort(), [selectedFile, anotherFile].sort());
  assert.deepEqual(selected.paths, multiple.call.result.filePaths);
  record("native multi-selection preserves both paths including a filename with spaces", selected);

  for (const [method, settings, accept] of [
    ["open", { mode: "file", defaultPath: selectedFile }, "open"],
    ["save", { defaultPath: savePath }, "save"],
  ]) {
    const exits = [];
    const request = yield* start(
      first.handle.dialog[method](options(settings)).pipe(
        Effect.onExit((exit) => Effect.sync(() => exits.push(exit))),
      ),
    );
    yield* visibleDialog(request.call);
    yield* Fiber.interrupt(request.fiber);
    const interrupted = yield* Fiber.await(request.fiber);
    assert.equal(interrupted._tag, "Failure");
    assert.equal(Cause.hasInterruptsOnly(interrupted.cause), true);
    yield* visibleDialog(request.call);
    assert.equal(request.call.settled, false);
    assert.equal("signal" in request.call.options, false);
    const beforeCompeting = calls.length;
    for (const competing of [
      second.handle.dialog.open(options({ mode: "file" })),
      second.handle.dialog.save(options()),
      second.handle.dialog.message({ message: "Competing dialog", buttons: ["OK"] }),
    ]) {
      assert.equal(failure(yield* Effect.exit(competing)).code, "Limit");
    }
    assert.equal(calls.length, beforeCompeting);
    yield* nativeDialog(request.call, accept);
    yield* dismissed(request.call);
    assert.equal(request.call.result.canceled, false);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]._tag, "Failure");
    assert.equal(Cause.hasInterruptsOnly(exits[0].cause), true);
    assert.equal(first.native.isDestroyed(), false);
    record(
      `${method} interruption abandons the request, retains native admission, and discards a late selection`,
    );
  }

  const message = yield* start(
    first.handle.dialog.message({
      title: `Sewed picker message ${process.pid}`,
      message: "Message owns admission",
      buttons: ["OK"],
    }),
  );
  yield* visibleDialog(message.call);
  const beforeMessageCompetition = calls.length;
  assert.equal(
    failure(yield* Effect.exit(second.handle.dialog.open(options({ mode: "file" })))).code,
    "Limit",
  );
  assert.equal(failure(yield* Effect.exit(second.handle.dialog.save(options()))).code, "Limit");
  assert.equal(calls.length, beforeMessageCompetition);
  yield* Fiber.interrupt(message.fiber);
  yield* dismissed(message.call);
  assert.equal(message.call.options.signal.aborted, true);
  record("pending message boxes exclude file pickers and retain native abort behavior");

  const requestScope = yield* Scope.fork(yield* Effect.scope);
  const scoped = yield* start(first.handle.dialog.open(options({ mode: "file" }))).pipe(
    Scope.provide(requestScope),
  );
  yield* visibleDialog(scoped.call);
  yield* Scope.close(requestScope, Exit.void);
  assert.equal(Cause.hasInterruptsOnly((yield* Fiber.await(scoped.fiber)).cause), true);
  yield* visibleDialog(scoped.call);
  assert.equal(first.native.isDestroyed(), false);
  yield* nativeDialog(scoped.call, "Escape");
  yield* dismissed(scoped.call);
  record("request scope closure leaves the native picker and its selected window alive");

  for (const method of ["open", "save"]) {
    const windowScope = yield* Scope.fork(yield* Effect.scope);
    const closing = yield* makeWindow(`${method} closing`).pipe(Scope.provide(windowScope));
    const settings = method === "open" ? { mode: "file" } : {};
    const request = yield* start(closing.handle.dialog[method](options(settings)));
    yield* visibleDialog(request.call);
    if (method === "open") closing.native.destroy();
    else yield* Scope.close(windowScope, Exit.void);
    assert.equal(
      failure(yield* Fiber.await(request.fiber).pipe(Effect.timeout(8_000))).code,
      "Closed",
    );
    const remaining = yield* nativeDialog(request.call);
    if (remaining.length > 0) yield* nativeDialog(request.call, "Escape");
    yield* dismissed(request.call);
    const beforeClosed = calls.length;
    assert.equal(
      failure(yield* Effect.exit(closing.handle.dialog[method](options(settings)))).code,
      "Closed",
    );
    assert.equal(calls.length, beforeClosed);
    record(
      `${method} parent closure fails pending and future requests without replacing the window`,
      {
        closure: method === "open" ? "native destroy" : "owner scope",
        nativePickerOutlivedParent: remaining.length > 0,
      },
    );
  }

  const realOpen = dialog.showOpenDialog;
  let release;
  const completion = new Promise((resolve) => {
    release = resolve;
  });
  let delayed;
  yield* replaceNative(
    "showOpenDialog",
    (parent, settings) => {
      delayed = realOpen(parent, settings).then((result) => completion.then(() => result));
      return delayed;
    },
    Effect.gen(function* () {
      const request = yield* start(first.handle.dialog.open(options({ mode: "file" })));
      yield* visibleDialog(request.call);
      yield* Fiber.interrupt(request.fiber);
      yield* nativeDialog(request.call, "Escape");
      yield* dismissed(request.call);
      assert.equal(failure(yield* Effect.exit(second.handle.dialog.save(options()))).code, "Limit");
      release();
      yield* Effect.promise(() => delayed);
    }).pipe(Effect.ensuring(Effect.sync(() => release()))),
  );
  const afterSettlement = yield* start(
    second.handle.dialog.save(options({ defaultPath: savePath })),
  );
  yield* respond(afterSettlement, "Escape");
  record("native promise settlement releases admission even when it follows native dismissal", {
    completionDelayInjected: true,
  });

  const invalidOpen = [
    {},
    { mode: "both" },
    { mode: "file", multiple: "yes" },
    { mode: "file", filters: [] },
    { mode: "file", filters: [{ name: "Text", extensions: [] }] },
    ...[".txt", "*.txt", "t*t", "tar.gz", "a/b", "a\\b", "a b", "a\u0000b"].map((extension) => ({
      mode: "file",
      filters: [{ name: "Text", extensions: [extension] }],
    })),
  ];
  const invalidSave = [{ defaultPath: 5 }, { filters: [{ name: "", extensions: ["txt"] }] }];
  const beforeInvalid = calls.length;
  for (const [method, inputs] of [
    ["open", invalidOpen],
    ["save", invalidSave],
  ]) {
    for (const input of inputs) {
      const error = failure(yield* Effect.exit(first.handle.dialog[method](input)));
      assert.equal(error.code, "Protocol");
      assert.equal(error.cause._tag, "SchemaError");
    }
  }
  assert.equal(calls.length, beforeInvalid);
  record("invalid picker modes, filters, and values fail before native invocation", {
    inputs: invalidOpen.length + invalidSave.length,
  });

  for (const method of ["open", "save"]) {
    const request = yield* start(
      first.handle.dialog[method](
        options({
          mode: "file",
          defaultPath: selectedFile,
          parent: second.native,
          securityScopedBookmarks: true,
          signal: new AbortController().signal,
          filters: [{ name: "All", extensions: ["*"] }],
        }),
      ),
    );
    assert.equal(request.call.parent, first.native);
    assert.equal("parent" in request.call.options, false);
    assert.equal("signal" in request.call.options, false);
    assert.equal("securityScopedBookmarks" in request.call.options, false);
    assert.deepEqual(
      request.call.options.properties,
      method === "open" ? ["openFile"] : ["showOverwriteConfirmation"],
    );
    yield* respond(request, "Escape");
  }
  record(
    "untyped extra options cannot replace parent, selection mode, abort behavior, or bookmark policy",
  );

  // Task 4 (wave 4): Dialog.SaveOptions.properties and Dialog.OpenOptions.properties are
  // Electron's own flags, forwarded verbatim beside the mode/multiplicity flags Sewed builds
  // itself — the "untyped extra options" case just above proves the field is no longer inert.
  const withOpenProperties = yield* start(
    first.handle.dialog.open(
      options({ mode: "file", defaultPath: selectedFile, properties: ["showHiddenFiles"] }),
    ),
  );
  assert.deepEqual(withOpenProperties.call.options.properties, ["openFile", "showHiddenFiles"]);
  yield* respond(withOpenProperties, "Escape");

  const withOpenMultipleProperties = yield* start(
    first.handle.dialog.open(
      options({
        mode: "file",
        multiple: true,
        defaultPath: selectedFile,
        properties: ["dontAddToRecent"],
      }),
    ),
  );
  assert.deepEqual(withOpenMultipleProperties.call.options.properties, [
    "openFile",
    "multiSelections",
    "dontAddToRecent",
  ]);
  yield* respond(withOpenMultipleProperties, "Escape");

  // A caller's own save properties are merged with "showOverwriteConfirmation", not replaced by
  // it: there is no door to turn the overwrite prompt off, naming other flags included.
  const withSaveProperties = yield* start(
    second.handle.dialog.save(options({ defaultPath: savePath, properties: ["dontAddToRecent"] })),
  );
  assert.deepEqual(withSaveProperties.call.options.properties, [
    "showOverwriteConfirmation",
    "dontAddToRecent",
  ]);
  yield* respond(withSaveProperties, "Escape");

  const withEmptySaveProperties = yield* start(
    second.handle.dialog.save(options({ defaultPath: savePath, properties: [] })),
  );
  assert.deepEqual(withEmptySaveProperties.call.options.properties, ["showOverwriteConfirmation"]);
  yield* respond(withEmptySaveProperties, "Escape");

  const withRedundantSaveProperty = yield* start(
    second.handle.dialog.save(
      options({ defaultPath: savePath, properties: ["showOverwriteConfirmation"] }),
    ),
  );
  assert.deepEqual(withRedundantSaveProperty.call.options.properties, [
    "showOverwriteConfirmation",
  ]);
  yield* respond(withRedundantSaveProperty, "Escape");

  const badProperty = failure(
    yield* Effect.exit(
      first.handle.dialog.open(options({ mode: "file", properties: ["openDirectory"] })),
    ),
  );
  assert.equal(badProperty.code, "Protocol");
  assert.equal(badProperty.cause._tag, "SchemaError");
  record(
    "Dialog.OpenOptions.properties reaches the native call verbatim, beside the mode and multiplicity flags Sewed builds; Dialog.SaveOptions.properties is merged with showOverwriteConfirmation rather than replacing it, deduplicated, even when given empty; a mode/multiplicity flag inside properties is refused",
  );

  for (const [method, nativeMethod, settings, invalidResult] of [
    ["open", "showOpenDialog", { mode: "file" }, { canceled: false, filePaths: [] }],
    ["save", "showSaveDialog", {}, { canceled: false, filePath: "" }],
  ]) {
    const nativeError = new Error(`fixture ${method} failure`);
    for (const fail of [
      () => {
        throw nativeError;
      },
      () => Promise.reject(nativeError),
    ]) {
      const error = failure(
        yield* replaceNative(
          nativeMethod,
          fail,
          Effect.exit(first.handle.dialog[method](options(settings))),
        ),
      );
      assert.equal(error.code, "Native");
      assert.equal(error.cause, nativeError);
    }
    const malformed = failure(
      yield* replaceNative(
        nativeMethod,
        () => Promise.resolve(invalidResult),
        Effect.exit(first.handle.dialog[method](options(settings))),
      ),
    );
    assert.equal(malformed.code, "Native");
    assert.equal(malformed.cause._tag, "SchemaError");
  }
  record("native throws, rejections, and invalid selected paths fail without leaking admission", {
    injected: true,
  });

  const destroyedDuringDecode = yield* makeWindow("decode closure");
  const beforeDecode = calls.length;
  const decodeError = failure(
    yield* Effect.exit(
      destroyedDuringDecode.handle.dialog.open({
        mode: "file",
        get title() {
          if (!destroyedDuringDecode.native.isDestroyed()) destroyedDuringDecode.native.destroy();
          return "Parent closed during decoding";
        },
      }),
    ),
  );
  assert.equal(decodeError.code, "Closed");
  assert.equal(calls.length, beforeDecode);
  record("parent liveness is rechecked after decoding before Electron can choose a fallback", {
    closureInjected: true,
  });

  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const owner = yield* host(
    Picker,
    Picker.toLayer({
      open: () => first.handle.dialog.open(options({ mode: "file", defaultPath: selectedFile })),
      save: () => first.handle.dialog.save(options({ defaultPath: savePath })),
    }),
  ).pipe(Scope.provide(ownerScope));
  yield* Effect.gen(function* () {
    const client = yield* PickerSlot();
    const request = yield* start(client.open());
    const result = yield* respond(request, "open");
    assert.equal(request.call.parent, first.native);
    assert.deepEqual(result.result, { kind: "selected", paths: [selectedFile] });
    record("a bound main client receives real selected paths through the public schema", result);
    const pending = yield* start(client.save());
    yield* visibleDialog(pending.call);
    yield* Scope.close(ownerScope, Exit.void);
    const error = failure(yield* Fiber.await(pending.fiber));
    assert.equal(error._tag, "SewedError");
    // The dialog was already visible — the request reached the handler, which was genuinely
    // mid-flight — when the owner's scope closed, so the answer is `Unknown` (reason
    // transport/lost-after-send), not `Closed`: the handler may have already run, and nothing
    // here may retry it.
    assert.equal(error.code, "Unknown");
    assert.equal(error.reason, "transport/lost-after-send");
    yield* visibleDialog(pending.call);
    assert.equal(first.native.isDestroyed(), false);
    yield* nativeDialog(pending.call, "save");
    yield* dismissed(pending.call);
    assert.equal(failure(yield* Effect.exit(client.open())).code, "Closed");
    record(
      "host closure answers a request already in flight Unknown, not Closed, and a late native response cannot revive it",
    );
  }).pipe(Effect.provide(Binding.layer([Binding.to(PickerSlot, owner)])));

  const rendererOwner = yield* host(
    Picker,
    Picker.toLayer({
      open: () => second.handle.dialog.open(options({ mode: "file", defaultPath: selectedFile })),
      save: () => second.handle.dialog.save(options({ defaultPath: savePath })),
    }),
  );
  const entry = Renderer.entry(
    new URL("../.artifacts/file-dialog-renderer/index.html", import.meta.url),
    { bindings: [PickerSlot] },
  );
  yield* second.handle.webContents.load(entry, {
    bindings: [Binding.to(PickerSlot, rendererOwner)],
  });
  const evaluate = (source) =>
    Effect.promise(() => second.native.webContents.executeJavaScript(source));
  yield* waitUntil(evaluate("Boolean(window.fileDialogFixture)"), "renderer picker client");
  let before = calls.length;
  yield* evaluate("window.fileDialogFixture.open()");
  const fromRenderer = yield* nextCall(before);
  assert.equal(fromRenderer.parent, second.native);
  yield* visibleDialog(fromRenderer);
  yield* nativeDialog(fromRenderer, "open");
  const rendererResult = yield* waitUntil(
    evaluate("window.fileDialogFixture.results[0]"),
    "renderer selected paths",
  );
  assert.deepEqual(rendererResult, {
    status: "success",
    value: { kind: "selected", paths: [selectedFile] },
  });
  yield* dismissed(fromRenderer);
  record("a real renderer receives native paths only through its selected binding", rendererResult);

  before = calls.length;
  yield* evaluate("window.fileDialogFixture.save()");
  const rendererCanceled = yield* nextCall(before);
  yield* visibleDialog(rendererCanceled);
  yield* evaluate("window.fileDialogFixture.cancel()");
  const rendererExit = yield* waitUntil(
    evaluate("window.fileDialogFixture.results[1]"),
    "renderer cancellation",
  );
  assert.deepEqual(rendererExit, { status: "failure", interrupted: true });
  yield* visibleDialog(rendererCanceled);
  yield* nativeDialog(rendererCanceled, "save");
  yield* dismissed(rendererCanceled);
  assert.equal(yield* evaluate("window.fileDialogFixture.results.length"), 2);
  record("renderer cancellation stays interruption and discards a later native save selection");

  before = calls.length;
  yield* evaluate("window.fileDialogFixture.open()");
  const reloaded = yield* nextCall(before);
  yield* visibleDialog(reloaded);
  yield* second.handle.webContents.reload;
  yield* waitUntil(
    evaluate("Boolean(window.fileDialogFixture) && window.fileDialogFixture.results.length === 0"),
    "fresh renderer document",
  );
  yield* visibleDialog(reloaded);
  const beforeFresh = calls.length;
  yield* evaluate("window.fileDialogFixture.open()");
  const blocked = yield* waitUntil(
    evaluate("window.fileDialogFixture.results[0]"),
    "fresh request blocked by old picker",
  );
  assert.equal(blocked.status, "failure");
  assert.equal(blocked.code, "Limit");
  assert.equal(calls.length, beforeFresh);
  yield* nativeDialog(reloaded, "open");
  yield* dismissed(reloaded);
  assert.equal(yield* evaluate("window.fileDialogFixture.results.length"), 1);
  before = calls.length;
  yield* evaluate("window.fileDialogFixture.save()");
  const fresh = yield* nextCall(before);
  assert.equal(fresh.parent, second.native);
  yield* visibleDialog(fresh);
  yield* nativeDialog(fresh, "Escape");
  const freshResult = yield* waitUntil(
    evaluate("window.fileDialogFixture.results[1]"),
    "fresh renderer result",
  );
  assert.deepEqual(freshResult, { status: "success", value: { kind: "canceled" } });
  yield* dismissed(fresh);
  record(
    "reload isolates documents and a fresh request waits for explicit retry after the old picker settles",
  );
  assert.equal(
    yield* Effect.promise(() => readFile(selectedFile, "utf8")),
    "Fixture file stays unchanged.\n",
  );
  yield* Effect.promise(() => assert.rejects(stat(savePath), { code: "ENOENT" }));
  assert.ok(calls.every((call) => call.settled));
});

App.run(
  [],
  Effect.gen(function* () {
    yield* App.decide(Decidables.App.LastWindowClosed, Decision.sync(() => "stay"));
    const result = yield* Effect.exit(runChecks);
    console.log(
      `FILE_DIALOG_VERIFICATION ${JSON.stringify({
        success: result._tag === "Success",
        checks,
        error: result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        platform: { os: process.platform, ozone: "x11", backend: "xdg-desktop-portal picker matched by title" },
        nativeInvocations: calls.length,
        settledInvocations: calls.filter((call) => call.settled).length,
      })}`,
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    yield* App.quit;
  }),
);
