import json
import sys
import x11_window as native


try:
    action = sys.argv[3] if len(sys.argv) > 3 else None
    if action in ("confirmation", "replace"):
        matches = [item for item in native.visible_windows(None) if item["parent"] == int(sys.argv[2])]
        if action == "replace":
            if len(matches) != 1:
                raise RuntimeError(f"Expected one overwrite confirmation, found {len(matches)}")
            native.send_key(matches[0]["window"], "r", focus=True, modifiers=("Alt_L",))
    else:
        matches = native.visible_windows(None, title=sys.argv[2])
    if action is not None and action not in ("confirmation", "replace"):
        if len(matches) != 1:
            raise RuntimeError(f"Expected one fixture picker, found {len(matches)}")
        window = matches[0]["window"]
        if action == "Escape":
            native.send_key(window, "Escape", focus=True)
        elif action in ("open", "save"):
            native.send_key(window, "o" if action == "open" else "s", focus=True, modifiers=("Alt_L",))
        elif action == "all":
            native.send_key(window, "Tab", focus=True, modifiers=("Shift_L",))
            native.send_key(window, "Down")
            native.send_key(window, "a", modifiers=("Control_L",))
        else:
            raise ValueError("Unsupported picker fixture action")
    native.check_errors()
    print(json.dumps(matches))
finally:
    native.close()
