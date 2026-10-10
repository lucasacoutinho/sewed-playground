#!/usr/bin/python3
"""Small private StatusNotifierWatcher/host used by the desktop acceptance fixture.

The fixture starts this process on a task-local D-Bus session.  It records the
real StatusNotifierItem registration and calls the item's public D-Bus methods;
it does not synthesize Electron callbacks.
"""

import hashlib
import json
import os
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib


WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
WATCHER_INTERFACE = "org.kde.StatusNotifierWatcher"
HOST_NAME = "org.kde.StatusNotifierHost.sewed.fixture"
HOST_PATH = "/StatusNotifierHost"
HOST_INTERFACE = "org.kde.StatusNotifierHost"
ITEM_INTERFACE = "org.kde.StatusNotifierItem"
PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"
DBUSMENU_INTERFACE = "com.canonical.dbusmenu"


def emit(event, **fields):
    payload = {"event": event, **fields}
    sys.stdout.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def json_value(value, *, compact=False):
    """Convert dbus-python values without dumping large icon byte arrays."""
    if isinstance(value, (dbus.ByteArray, bytes, bytearray)):
        raw = bytes(value)
        return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    if isinstance(value, dbus.ObjectPath):
        return str(value)
    if isinstance(value, dbus.String):
        return str(value)
    if isinstance(value, (dbus.Boolean, dbus.Int16, dbus.Int32, dbus.Int64,
                          dbus.UInt16, dbus.UInt32, dbus.UInt64, dbus.Double)):
        return value.item() if hasattr(value, "item") else value
    if isinstance(value, dict):
        return {str(key): json_value(item, compact=compact) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        if compact and len(value) > 32:
            return {"items": len(value), "head": [json_value(item, compact=True) for item in value[:4]]}
        return [json_value(item, compact=compact) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def text_value(value):
    """Return a stable human-readable string from StatusNotifier tooltip data."""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        parts = [text_value(item) for item in value]
        return " ".join(part for part in parts if part)
    if isinstance(value, dict):
        return " ".join(text_value(item) for item in value.values())
    return "" if value is None else str(value)


def service_and_path(service):
    value = str(service)
    if value.startswith("/"):
        return value, "/StatusNotifierItem"
    if "/" in value:
        name, path = value.split("/", 1)
        return name, "/" + path
    return value, "/StatusNotifierItem"


def menu_node(node):
    if not isinstance(node, (list, tuple)) or len(node) < 3:
        return {"raw": json_value(node, compact=True)}
    node_id, props, children = node[0], node[1], node[2]
    props = {str(key): value for key, value in props.items()} if isinstance(props, dict) else {}
    result = {
        "id": int(node_id),
        "label": str(props.get("label", "")),
        "type": str(props.get("type", "")),
        "enabled": bool(props.get("enabled", True)),
        "visible": bool(props.get("visible", True)),
    }
    if children:
        result["children"] = [menu_node(child) for child in children]
    return result


def walk_menu(node):
    yield node
    for child in node.get("children", []):
        yield from walk_menu(child)


class Watcher(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, WATCHER_PATH)
        self.items = {}
        self.owners = {}
        self.hosts = set()

    @dbus.service.method(WATCHER_INTERFACE, in_signature="s", out_signature="", sender_keyword="sender")
    def RegisterStatusNotifierItem(self, service, sender=None):
        value = str(service)
        if value.startswith("/"):
            key = str(sender or value)
            item_path = value
            owner = str(sender or value)
        else:
            key = value
            owner, item_path = service_and_path(value)
        self.items[key] = item_path
        self.owners[key] = owner
        self.StatusNotifierItemRegistered(key)
        emit("registered", service=key, owner=owner, path=item_path)

    @dbus.service.method(WATCHER_INTERFACE, in_signature="s", out_signature="")
    def RegisterStatusNotifierHost(self, service):
        key = str(service)
        self.hosts.add(key)
        self.StatusNotifierHostRegistered(key)
        emit("host-registered", service=key)

    @dbus.service.method(WATCHER_INTERFACE, in_signature="", out_signature="as")
    def GetRegisteredStatusNotifierItems(self):
        return dbus.Array(list(self.items.keys()), signature="s")

    @dbus.service.method(WATCHER_INTERFACE, in_signature="", out_signature="b")
    def GetIsStatusNotifierHostRegistered(self):
        return bool(self.hosts)

    @dbus.service.method(WATCHER_INTERFACE, in_signature="", out_signature="i")
    def GetProtocolVersion(self):
        return 0

    @dbus.service.signal(WATCHER_INTERFACE, signature="s")
    def StatusNotifierItemRegistered(self, service):
        pass

    @dbus.service.signal(WATCHER_INTERFACE, signature="s")
    def StatusNotifierItemUnregistered(self, service):
        pass

    @dbus.service.signal(WATCHER_INTERFACE, signature="s")
    def StatusNotifierHostRegistered(self, service):
        pass

    @dbus.service.signal(WATCHER_INTERFACE, signature="s")
    def StatusNotifierHostUnregistered(self, service):
        pass

    @dbus.service.method(PROPERTIES_INTERFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        if interface != WATCHER_INTERFACE:
            raise dbus.exceptions.DBusException("org.freedesktop.DBus.Error.InvalidArgs")
        values = {
            "RegisteredStatusNotifierItems": dbus.Array(list(self.items.keys()), signature="s"),
            "IsStatusNotifierHostRegistered": dbus.Boolean(bool(self.hosts)),
            "ProtocolVersion": dbus.Int32(0),
        }
        if prop not in values:
            raise dbus.exceptions.DBusException("org.freedesktop.DBus.Error.UnknownProperty")
        return values[prop]

    @dbus.service.method(PROPERTIES_INTERFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != WATCHER_INTERFACE:
            return {}
        return {
            "RegisteredStatusNotifierItems": dbus.Array(list(self.items.keys()), signature="s"),
            "IsStatusNotifierHostRegistered": dbus.Boolean(bool(self.hosts)),
            "ProtocolVersion": dbus.Int32(0),
        }


class Host(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, HOST_PATH)


class Probe:
    def __init__(self, bus, watcher):
        self.bus = bus
        self.watcher = watcher

    def proxy(self, service):
        key = str(service)
        name = self.watcher.owners.get(key)
        path = self.watcher.items.get(key)
        if name is None or path is None:
            name, path = service_and_path(key)
        return name, path, self.bus.get_object(name, path)

    def property(self, service, name):
        _, _, proxy = self.proxy(service)
        return dbus.Interface(proxy, PROPERTIES_INTERFACE).Get(ITEM_INTERFACE, name)

    def snapshot(self, service):
        values = {}
        for name in ("Id", "Title", "Status", "IconName", "IconPixmap", "ToolTip", "Menu", "Category"):
            try:
                values[name] = json_value(self.property(service, name), compact=True)
            except Exception as error:
                values[name] = {"error": str(error)}
        values["tooltipText"] = text_value(values.get("ToolTip"))
        values["menuPath"] = str(values.get("Menu", ""))
        values["iconSignature"] = json.dumps(values.get("IconPixmap"), sort_keys=True)
        values["service"] = str(service)
        values["path"] = self.watcher.items.get(str(service), service_and_path(service)[1])
        return values

    def menu_layout(self, service):
        menu_path = self.property(service, "Menu")
        name, _, _ = self.proxy(service)
        proxy = self.bus.get_object(name, str(menu_path))
        revision, node = dbus.Interface(proxy, DBUSMENU_INTERFACE).GetLayout(
            dbus.Int32(0), dbus.Int32(-1),
            dbus.Array(["label", "type", "enabled", "visible", "children-display"], signature="s"),
            timeout=2.0,
        )
        return {"revision": int(revision), "root": menu_node(node)}

    def call_item(self, service, method, *args):
        _, _, proxy = self.proxy(service)
        return getattr(dbus.Interface(proxy, ITEM_INTERFACE), method)(*args)

    def call_menu_event(self, service, item_id):
        menu_path = self.property(service, "Menu")
        name, _, _ = self.proxy(service)
        menu_proxy = self.bus.get_object(name, str(menu_path))
        return dbus.Interface(menu_proxy, DBUSMENU_INTERFACE).Event(
            dbus.Int32(int(item_id)), dbus.String("clicked"), dbus.String("", variant_level=1), dbus.UInt32(0)
        )


def first_service(watcher):
    return next(iter(watcher.items), None)


def emit_snapshot(probe, watcher, service=None):
    targets = [service] if service else list(watcher.items)
    for key in targets:
        if key not in watcher.items:
            continue
        try:
            emit("snapshot", item=probe.snapshot(key))
        except Exception as error:
            emit("error", operation="snapshot", service=key, message=str(error))


def emit_menu_layout(probe, watcher, service=None):
    service = service or first_service(watcher)
    if not service:
        emit("error", operation="menu-layout", message="no registered item")
        return
    try:
        emit("menu-layout", service=service, layout=probe.menu_layout(service))
    except Exception as error:
        emit("error", operation="menu-layout", service=service, message=str(error))


def invoke(probe, watcher, command):
    name = command.get("cmd")
    service = command.get("service") or first_service(watcher)
    try:
        if name == "snapshot":
            emit_snapshot(probe, watcher, service)
        elif name == "menu-layout":
            emit_menu_layout(probe, watcher, service)
        elif name == "activate":
            probe.call_item(service, "Activate", dbus.Int32(0), dbus.Int32(0))
        elif name == "context-menu":
            probe.call_item(service, "ContextMenu", dbus.Int32(0), dbus.Int32(0))
        elif name == "secondary-activate":
            probe.call_item(service, "SecondaryActivate", dbus.Int32(0), dbus.Int32(0))
        elif name == "menu-event":
            item_id = command.get("id")
            if item_id is None:
                raise RuntimeError("menu-event requires a dbusmenu item id")
            probe.call_menu_event(service, item_id)
            emit("menu-event", service=service, id=int(item_id))
        elif name == "stop":
            emit("command", command=name, ok=True)
            return False
        else:
            raise RuntimeError("unknown command: " + str(name))
        if name not in ("snapshot", "menu-layout"):
            emit("command", command=name, service=service, ok=True)
    except Exception as error:
        emit("command", command=name, service=service, ok=False, message=str(error))
    return True


def main():
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        emit("error", operation="startup", message="DBUS_SESSION_BUS_ADDRESS is missing")
        return 2

    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    try:
        watcher_name = dbus.service.BusName(WATCHER_NAME, bus=bus, do_not_queue=True)
        host_name = dbus.service.BusName(HOST_NAME, bus=bus, do_not_queue=True)
    except Exception as error:
        emit("error", operation="startup", message="could not own private watcher/host names: " + str(error))
        return 2
    watcher = Watcher(bus)
    host = Host(bus)
    probe = Probe(bus, watcher)
    loop = GLib.MainLoop()

    def name_owner_changed(name, old_owner, new_owner):
        if new_owner:
            return
        name = str(name)
        removed = [key for key, owner in watcher.owners.items() if owner == name or key == name]
        for key in removed:
            watcher.items.pop(key, None)
            watcher.owners.pop(key, None)
            watcher.StatusNotifierItemUnregistered(key)
            emit("unregistered", service=key)

    def item_signal(*args, **kwargs):
        path = str(kwargs.get("path", ""))
        sender = str(kwargs.get("sender", ""))
        emit("signal", signal=kwargs.get("signal", ""), path=path, sender=sender)

    bus.add_signal_receiver(
        name_owner_changed,
        signal_name="NameOwnerChanged",
        dbus_interface="org.freedesktop.DBus",
    )
    for signal_name in ("NewTitle", "NewIcon", "NewToolTip", "NewStatus"):
        bus.add_signal_receiver(
            item_signal,
            signal_name=signal_name,
            dbus_interface=ITEM_INTERFACE,
            path_keyword="path",
            sender_keyword="sender",
        )
    bus.add_signal_receiver(
        item_signal,
        signal_name="PropertiesChanged",
        dbus_interface=PROPERTIES_INTERFACE,
        path_keyword="path",
        sender_keyword="sender",
    )

    pending_input = bytearray()

    def on_stdin(_source, _condition):
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            loop.quit()
            return False
        pending_input.extend(chunk)
        while b"\n" in pending_input:
            line, _, remainder = pending_input.partition(b"\n")
            pending_input[:] = remainder
            try:
                command = json.loads(line)
                emit("received", command=command.get("cmd"))
                if not invoke(probe, watcher, command):
                    loop.quit()
                    return False
            except Exception as error:
                emit("error", operation="command-parse", message=str(error))
        return True

    def register_host():
        def registered():
            emit("ready", watcher=WATCHER_NAME, host=HOST_NAME)

        def failed(error):
            emit("error", operation="host-registration", message=str(error))

        try:
            # The host registration is an asynchronous D-Bus call because the
            # watcher and host share this connection.  Electron's later
            # RegisterStatusNotifierItem call is a separate external request.
            proxy = bus.get_object(WATCHER_NAME, WATCHER_PATH)
            dbus.Interface(proxy, WATCHER_INTERFACE).RegisterStatusNotifierHost(
                HOST_NAME, reply_handler=registered, error_handler=failed,
            )
        except Exception as error:
            failed(error)
        return False

    GLib.io_add_watch(sys.stdin, GLib.IO_IN, on_stdin)
    GLib.idle_add(register_host)
    loop.run()
    del host, host_name, watcher_name
    return 0


if __name__ == "__main__":
    sys.exit(main())
