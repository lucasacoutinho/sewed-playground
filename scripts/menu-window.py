import json
import sys
import x11_window as native

try:
    pid = int(sys.argv[1])
    parent = int(sys.argv[2])
    matches = native.visible_windows(pid, window_type="_NET_WM_WINDOW_TYPE_MENU")
    if len(sys.argv) == 4 and sys.argv[3] == "focus":
        if not any(window["window"] == parent for window in native.visible_windows(pid)):
            raise RuntimeError("The requested fixture parent is not visible")
        native.x11.XSetInputFocus(native.display, parent, native.REVERT_TO_PARENT, 0)
        native.x11.XSync(native.display, 0)
    elif len(sys.argv) == 4:
        if not matches:
            raise RuntimeError("No native fixture popup is visible")
        parents = native.visible_windows(pid)
        if not any(window["window"] == parent for window in parents):
            raise RuntimeError("The requested fixture parent is not visible")
        native.send_key(parent, sys.argv[3], focus=True)
    native.check_errors()
    print(json.dumps(matches))
finally:
    native.close()
