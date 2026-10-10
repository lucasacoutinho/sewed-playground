import json
import sys
import x11_window as native

try:
    matches = native.visible_windows(int(sys.argv[1]), title=sys.argv[2])
    if len(sys.argv) == 4:
        if len(matches) != 1:
            raise RuntimeError(f"Expected one fixture dialog, found {len(matches)}")
        if sys.argv[3] not in ("Return", "Escape"):
            raise ValueError("The dialog fixture only sends Return or Escape")
        native.send_key(matches[0]["window"], sys.argv[3], focus=True)
    native.check_errors()
    print(json.dumps(matches))
finally:
    native.close()
