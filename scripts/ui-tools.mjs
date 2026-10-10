import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

// Builds the isolated display tools the harness needs without root: Xvfb and Openbox extracted
// from Debian packages into .artifacts/ui-tools, plus the two wrappers with-xvfb.py expects.
const root = resolve(".artifacts/ui-tools");
const debs = resolve(root, "debs");
const extracted = resolve(root, "root");
const packages = [
  "xvfb",
  "xserver-common",
  "x11-xkb-utils",
  "xauth",
  "libxfont2",
  "libfontenc1",
  "openbox",
  "libobrender32v5",
  "libobt2v5",
  "libpangoxft-1.0-0",
  "libstartup-notification0",
  "libimlib2t64",
];
mkdirSync(debs, { recursive: true });
mkdirSync(extracted, { recursive: true });
const run = (command, args, options = {}) => {
  const outcome = spawnSync(command, args, { stdio: "inherit", ...options });
  if (outcome.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};
const present = () => readdirSync(debs).filter((name) => name.endsWith(".deb"));
const missing = packages.filter((name) => !present().some((file) => file.startsWith(`${name}_`)));
if (missing.length > 0) run("apt-get", ["download", ...missing], { cwd: debs });
for (const file of present()) run("dpkg-deb", ["-x", resolve(debs, file), extracted]);
const xkbcomp = resolve(extracted, "usr/bin/xkbcomp");
const xvfb = resolve(extracted, "usr/bin/Xvfb");
const libraries = resolve(extracted, "usr/lib/x86_64-linux-gnu");
if (!existsSync(xvfb) || !existsSync(xkbcomp)) throw new Error("Xvfb or xkbcomp was not extracted");
writeFileSync(
  resolve(root, "xvfb.sh"),
  `#!/bin/sh
auth=""; previous=""
for argument in "$@"; do
  [ "$previous" = "-auth" ] && auth="$argument"
  previous="$argument"
done
if [ -n "$auth" ]; then
  directory=$(dirname "$auth")
  set -- --ro-bind "$directory" "$directory" -- "${xvfb}" "$@"
else
  set -- -- "${xvfb}" "$@"
fi
exec bwrap --ro-bind / / --tmpfs /tmp --tmpfs /run --ro-bind /usr/bin /run/original-bin --tmpfs /usr/bin --symlink /run/original-bin/dash /usr/bin/sh --ro-bind "${xkbcomp}" /usr/bin/xkbcomp --setenv LD_LIBRARY_PATH "${libraries}" "$@"
`,
);
writeFileSync(
  resolve(root, "openbox.sh"),
  `#!/bin/sh
export LD_LIBRARY_PATH="${libraries}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_CONFIG_DIRS="${resolve(extracted, "etc/xdg")}\${XDG_CONFIG_DIRS:+:$XDG_CONFIG_DIRS}"
export XDG_DATA_DIRS="${resolve(extracted, "usr/share")}:\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
exec "${resolve(extracted, "usr/bin/openbox")}" "$@"
`,
);
for (const wrapper of ["xvfb.sh", "openbox.sh"]) chmodSync(resolve(root, wrapper), 0o755);
console.log(`export SEWED_XVFB=${resolve(root, "xvfb.sh")} SEWED_WINDOW_MANAGER=${resolve(root, "openbox.sh")}`);
