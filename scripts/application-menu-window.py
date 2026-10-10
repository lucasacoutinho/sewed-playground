import json
import sys
import x11_window as native

try:
    pid = int(sys.argv[1])
    parent = int(sys.argv[2])
    windows = native.visible_windows(pid)
    if not any(window["window"] == parent for window in windows):
        raise RuntimeError("The requested fixture window is not visible")
    native.send_key(parent, sys.argv[3], focus=True, modifiers=sys.argv[4:])
    native.check_errors()
    print(json.dumps({"parent": parent, "key": sys.argv[3], "modifiers": sys.argv[4:]}))
finally:
    native.close()
