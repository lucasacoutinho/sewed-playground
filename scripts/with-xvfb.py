import fcntl
import os
from pathlib import Path
import secrets
import select
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import time


def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def field(value):
    return struct.pack("!H", len(value)) + value


def release_portal_mounts(directory):
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields, filesystem = line.split(" - ", 1)
        mountpoint = fields.split()[4]
        if filesystem.split()[0] == "fuse.portal" and mountpoint.startswith(directory + "/"):
            subprocess.run(["fusermount3", "-uz", mountpoint], check=True)


if len(sys.argv) < 2:
    raise SystemExit("Usage: python3 scripts/with-xvfb.py command [arguments...]")

signal.signal(signal.SIGTERM, interrupted)
window_manager = os.environ.get("SEWED_WINDOW_MANAGER") or shutil.which("openbox")
if not window_manager:
    raise SystemExit("Geometry verification needs an EWMH window manager. Install Openbox or set SEWED_WINDOW_MANAGER to its executable; Xvfb alone cannot maximize windows.")
if not shutil.which("xprop"):
    raise SystemExit("Install xprop to verify that the isolated window manager is ready.")
Path(".artifacts").mkdir(exist_ok=True)
# One isolated display at a time: overlapping runs made Openbox fail to open the display.
lock = Path(".artifacts/xvfb.lock").open("w")
fcntl.flock(lock, fcntl.LOCK_EX)
server = None
command = None
manager = None
with tempfile.TemporaryDirectory(prefix="sewed-xvfb-") as directory:
    auth = Path(directory) / "authority"
    auth.touch(mode=0o600)
    auth.write_bytes(
        struct.pack("!H", 65535) + field(b"") + field(b"")
        + field(b"MIT-MAGIC-COOKIE-1") + field(secrets.token_bytes(16))
    )
    with Path(".artifacts/xvfb.log").open("w") as log:
        try:
            server = subprocess.Popen(
                [os.environ.get("SEWED_XVFB", "Xvfb"), "-displayfd", "1",
                 "-nolisten", "unix", "-nolisten", "local", "-listen", "tcp",
                 "-screen", "0", "1280x800x24", "-auth", str(auth)],
                stdout=subprocess.PIPE, stderr=log, start_new_session=True,
            )
            ready, _, _ = select.select([server.stdout], [], [], 10)
            if not ready:
                raise RuntimeError("Xvfb did not start; see .artifacts/xvfb.log")
            display = server.stdout.readline().strip().decode("ascii")
            if not display.isdecimal():
                raise RuntimeError("Xvfb failed to start; see .artifacts/xvfb.log")
            environment = {
                **os.environ,
                "DISPLAY": f"127.0.0.1:{display}",
                "XAUTHORITY": str(auth),
                "WAYLAND_DISPLAY": "",
                "XDG_CONFIG_HOME": str(Path(directory) / "config"),
                "XDG_CACHE_HOME": str(Path(directory) / "cache"),
                "XDG_DATA_HOME": str(Path(directory) / "data"),
            }
            with Path(".artifacts/window-manager.log").open("w") as manager_log:
                manager = subprocess.Popen(
                    [window_manager], env=environment, start_new_session=True,
                    stdout=manager_log, stderr=manager_log,
                )
                for _ in range(100):
                    if manager.poll() is not None:
                        raise RuntimeError("Window manager exited; see .artifacts/window-manager.log")
                    try:
                        result = subprocess.run(
                            ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], env=environment,
                            capture_output=True, text=True, timeout=2,
                        )
                    except subprocess.TimeoutExpired:
                        # A slow probe on a busy machine is "not ready yet", like any other miss.
                        continue
                    if "window id # 0x" in result.stdout:
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Window manager did not advertise EWMH support")
                command = subprocess.Popen(sys.argv[1:], start_new_session=True, env=environment)
            # One fixture fits in 90 seconds; verify:all needs SEWED_XVFB_TIMEOUT raised.
            raise SystemExit(command.wait(timeout=float(os.environ.get("SEWED_XVFB_TIMEOUT", "90"))))
        finally:
            stop(command)
            stop(manager)
            stop(server)
            release_portal_mounts(directory)
