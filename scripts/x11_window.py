import ctypes as c


BAD_WINDOW = 3
IS_VIEWABLE = 2
REVERT_TO_PARENT = 2
x11 = c.CDLL("libX11.so.6")
Display = c.c_void_p
Window = c.c_ulong
Atom = c.c_ulong
x11.XOpenDisplay.argtypes = [c.c_char_p]
x11.XOpenDisplay.restype = Display
x11.XDefaultRootWindow.argtypes = [Display]
x11.XDefaultRootWindow.restype = Window
x11.XInternAtom.argtypes = [Display, c.c_char_p, c.c_int]
x11.XInternAtom.restype = Atom
x11.XGetWindowProperty.argtypes = [
    Display, Window, Atom, c.c_long, c.c_long, c.c_int, Atom,
    c.POINTER(Atom), c.POINTER(c.c_int), c.POINTER(c.c_ulong),
    c.POINTER(c.c_ulong), c.POINTER(c.POINTER(c.c_ubyte)),
]
x11.XQueryTree.argtypes = [
    Display, Window, c.POINTER(Window), c.POINTER(Window),
    c.POINTER(c.POINTER(Window)), c.POINTER(c.c_uint),
]
x11.XGetTransientForHint.argtypes = [Display, Window, c.POINTER(Window)]
x11.XFree.argtypes = [c.c_void_p]
x11.XCloseDisplay.argtypes = [Display]
x11.XStringToKeysym.argtypes = [c.c_char_p]
x11.XStringToKeysym.restype = c.c_ulong
x11.XKeysymToKeycode.argtypes = [Display, c.c_ulong]
x11.XKeysymToKeycode.restype = c.c_uint
x11.XSync.argtypes = [Display, c.c_int]
x11.XSetInputFocus.argtypes = [Display, Window, c.c_int, c.c_ulong]
x11.XGetInputFocus.argtypes = [Display, c.POINTER(Window), c.POINTER(c.c_int)]
xtst = c.CDLL("libXtst.so.6")
xtst.XTestFakeKeyEvent.argtypes = [Display, c.c_uint, c.c_int, c.c_ulong]


class Attributes(c.Structure):
    _fields_ = [
        ("x", c.c_int), ("y", c.c_int), ("width", c.c_int), ("height", c.c_int),
        ("border_width", c.c_int), ("depth", c.c_int), ("visual", c.c_void_p),
        ("root", Window), ("window_class", c.c_int), ("bit_gravity", c.c_int),
        ("win_gravity", c.c_int), ("backing_store", c.c_int),
        ("backing_planes", c.c_ulong), ("backing_pixel", c.c_ulong),
        ("save_under", c.c_int), ("colormap", c.c_ulong), ("map_installed", c.c_int),
        ("map_state", c.c_int), ("all_event_masks", c.c_long),
        ("your_event_mask", c.c_long), ("do_not_propagate_mask", c.c_long),
        ("override_redirect", c.c_int), ("screen", c.c_void_p),
    ]


class ErrorEvent(c.Structure):
    _fields_ = [
        ("type", c.c_int), ("display", Display), ("resourceid", c.c_ulong),
        ("serial", c.c_ulong), ("error_code", c.c_ubyte),
        ("request_code", c.c_ubyte), ("minor_code", c.c_ubyte),
    ]


errors = []
ErrorHandler = c.CFUNCTYPE(c.c_int, Display, c.POINTER(ErrorEvent))


@ErrorHandler
def on_error(_display, error):
    if error.contents.error_code != BAD_WINDOW:
        errors.append(error.contents.error_code)
    return 0


x11.XSetErrorHandler.argtypes = [ErrorHandler]
x11.XSetErrorHandler(on_error)
x11.XGetWindowAttributes.argtypes = [Display, Window, c.POINTER(Attributes)]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError("The native fixture needs an X11 display")


def property_value(window, name):
    actual_type = Atom()
    actual_format = c.c_int()
    count = c.c_ulong()
    after = c.c_ulong()
    data = c.POINTER(c.c_ubyte)()
    status = x11.XGetWindowProperty(
        display, window, x11.XInternAtom(display, name.encode(), 0), 0, 65536,
        0, 0, c.byref(actual_type), c.byref(actual_format), c.byref(count),
        c.byref(after), c.byref(data),
    )
    try:
        if status != 0 or not data:
            return None
        if actual_format.value == 32:
            return list(c.cast(data, c.POINTER(c.c_ulong))[:count.value])
        if actual_format.value == 8:
            return c.string_at(data, count.value).decode("utf-8", "replace")
        return None
    finally:
        if data:
            x11.XFree(data)


def children_of(window):
    root_return = Window()
    parent_return = Window()
    children = c.POINTER(Window)()
    count = c.c_uint()
    x11.XQueryTree(display, window, c.byref(root_return), c.byref(parent_return), c.byref(children), c.byref(count))
    result = list(children[:count.value])
    if children:
        x11.XFree(children)
    return result


def visible_windows(pid, title=None, window_type=None):
    windows = children_of(x11.XDefaultRootWindow(display))
    for child in list(windows):
        windows.extend(children_of(child))
    matches = []
    for window in windows:
        # Portal-backed dialogs belong to the portal's process; pass pid=None to match by title only.
        if pid is not None and property_value(window, "_NET_WM_PID") != [pid]:
            continue
        name = property_value(window, "_NET_WM_NAME")
        if title is not None and name != title:
            continue
        if window_type is not None:
            kind = x11.XInternAtom(display, window_type.encode(), 0)
            if kind not in (property_value(window, "_NET_WM_WINDOW_TYPE") or []):
                continue
        attributes = Attributes()
        if not x11.XGetWindowAttributes(display, window, c.byref(attributes)) or attributes.map_state != IS_VIEWABLE:
            continue
        parent = Window()
        x11.XGetTransientForHint(display, window, c.byref(parent))
        matches.append({"window": window, "parent": parent.value, "title": name})
    return matches


def send_key(window, key, focus=False, modifiers=()):
    if key not in ("Return", "Escape", "Down", "Up", "Right", "Left", "Home", "End", "Tab") and not (len(key) == 1 and "a" <= key <= "z"):
        raise ValueError("Unsupported native fixture key")
    if any(modifier not in ("Control_L", "Shift_L", "Alt_L") for modifier in modifiers):
        raise ValueError("Unsupported native fixture modifier")
    if focus:
        x11.XSetInputFocus(display, window, REVERT_TO_PARENT, 0)
    focused = Window()
    revert_to = c.c_int()
    x11.XGetInputFocus(display, c.byref(focused), c.byref(revert_to))
    if focused.value != window:
        raise RuntimeError(f"Fixture window {window} does not have focus (actual {focused.value})")
    keycodes = [x11.XKeysymToKeycode(display, x11.XStringToKeysym(value.encode())) for value in (*modifiers, key)]
    if not all(keycodes):
        raise RuntimeError("The fixture key has no native keycode")
    try:
        for keycode in keycodes:
            if not xtst.XTestFakeKeyEvent(display, keycode, 1, 0):
                raise RuntimeError("Could not send a key to the fixture window")
    finally:
        for keycode in reversed(keycodes):
            xtst.XTestFakeKeyEvent(display, keycode, 0, 0)
        x11.XSync(display, 0)


def check_errors():
    if errors:
        raise RuntimeError(f"X11 errors: {errors}")


def close():
    x11.XCloseDisplay(display)
